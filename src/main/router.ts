// Hexllama's OpenAI-compatible HTTP router. Pi.dev (and any other OpenAI client)
// talks to this server on a fixed port; the router enumerates every GGUF on
// disk, swaps the running llama-server on demand, and forwards requests.
//
// Phase 1: catalog + /v1/models. Swap logic lives in `serveCompletion` below
// and is filled in by phase 2 (TaskCreate #7).

import { app } from 'electron'
import http from 'http'
import os from 'os'
import { spawn, ChildProcess } from 'child_process'
import { join, extname, basename, dirname, resolve } from 'path'
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, promises as fsPromises } from 'fs'
import { readNativeContext } from './gguf'

const APP_ROOT = app.isPackaged ? app.getPath('userData') : process.cwd()
const MODELS_DIR = join(APP_ROOT, 'models')
const TEMPLATES_DIR = join(APP_ROOT, 'templates')
const BACKEND_DIR = join(APP_ROOT, 'backend')
const SETTINGS_PATH = join(APP_ROOT, 'settings.json')
// PID file for the spawned llama-server; lets us kill orphans across crashes / dev hot-reloads.
const PID_FILE = join(APP_ROOT, '.router-llama.pid')

const MODEL_EXTS = ['.gguf', '.bin', '.ggml']
const DEFAULT_PORT = 7878
// Port the router spawns its swap-managed llama-server on. Kept separate from
// user-managed cards so the two lifecycles don't collide.
const LLAMA_SLOT_PORT = 18080
const HEALTH_TIMEOUT_MS = 120_000
const HEALTH_POLL_MS = 500
// Upper bound for both spawn `-c` and the pi config's `contextWindow`. Each model's
// reported native context is clamped to this so we never blow the KV-cache budget.
const MAX_CTX_DEFAULT = 131_072
// Conservative fallback for models we can't read metadata from (non-GGUF, bin, etc.)
const FALLBACK_CTX = 8192

interface AppSettingsShape {
  externalModelFolders?: string[]
  piIntegration?: { enabled?: boolean; port?: number }
}

interface ModelEntry {
  id: string             // pi-facing stable id (slug of filename minus extension)
  filename: string       // foo.gguf
  path: string           // absolute path
  size: number
  external: boolean
  nativeCtx: number | null  // from GGUF metadata; null = unknown/unreadable
}

function clampedCtx(native: number | null): number {
  if (!native || native < 512) return FALLBACK_CTX
  return Math.min(native, MAX_CTX_DEFAULT)
}

interface RouterState {
  port: number
  server: http.Server | null
  catalog: ModelEntry[]
  currentModelId: string | null
  currentLlamaPort: number | null
  currentProc: ChildProcess | null
  // Single in-flight swap so concurrent /v1/chat/completions calls don't race.
  swapping: Promise<void> | null
}

const state: RouterState = {
  port: DEFAULT_PORT,
  server: null,
  catalog: [],
  currentModelId: null,
  currentLlamaPort: null,
  currentProc: null,
  swapping: null
}

function slugify(filename: string): string {
  return filename
    .replace(/\.(gguf|bin|ggml)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function loadSettings(): Promise<AppSettingsShape> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {}
    return JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

async function scanModels(): Promise<ModelEntry[]> {
  const out: ModelEntry[] = []
  const seen = new Set<string>()
  const scan = async (dir: string, external: boolean) => {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (e.isDirectory()) {
          await scan(join(dir, e.name), external)
        } else if (
          MODEL_EXTS.includes(extname(e.name).toLowerCase()) &&
          !e.name.endsWith('.tmp')
        ) {
          const fp = join(dir, e.name)
          const key = resolve(fp)
          if (seen.has(key)) continue
          seen.add(key)
          const st = await fsPromises.stat(fp)
          // GGUF metadata read is cheap (one ~4MB read, cached by size+mtime).
          // .bin/.ggml legacy files return null; we'll fall back to FALLBACK_CTX.
          const nativeCtx = e.name.toLowerCase().endsWith('.gguf') ? await readNativeContext(fp) : null
          out.push({
            id: slugify(e.name),
            filename: e.name,
            path: fp,
            size: st.size,
            external,
            nativeCtx
          })
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  if (existsSync(MODELS_DIR)) await scan(MODELS_DIR, false)
  const settings = await loadSettings()
  for (const folder of settings.externalModelFolders || []) {
    if (existsSync(folder)) await scan(folder, true)
  }
  return out
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  })
  res.end(JSON.stringify(body))
}

function notFound(res: http.ServerResponse) {
  jsonResponse(res, 404, { error: { message: 'Not found', type: 'invalid_request_error' } })
}

function serveModels(res: http.ServerResponse) {
  // OpenAI-shaped list. `created` is bogus for local files; clients ignore it.
  const data = state.catalog.map(m => ({
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: 'hexllama',
    // Non-standard fields hexllama-aware clients can use:
    filename: m.filename,
    path: m.path,
    size_bytes: m.size,
    external: m.external
  }))
  jsonResponse(res, 200, { object: 'list', data })
}

interface ResolvedSpawn {
  exe: string
  args: string[]
  port: number
}

interface TemplateLike {
  id?: string
  modelPath?: string
  backendVersion?: string
  args?: Record<string, string | number | boolean | null>
}

function readTemplates(): TemplateLike[] {
  if (!existsSync(TEMPLATES_DIR)) return []
  const out: TemplateLike[] = []
  for (const f of readdirSync(TEMPLATES_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8')))
    } catch {
      // ignore unparseable files
    }
  }
  return out
}

function findLlamaServerBinary(): string | null {
  if (!existsSync(BACKEND_DIR)) return null
  const targetNames = process.platform === 'win32' ? ['llama-server.exe', 'llama-server'] : ['llama-server']
  // Walk newest backend dir first — name suffix usually carries the build number.
  const dirs = readdirSync(BACKEND_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort((a, b) => {
      const n = (s: string) => parseInt((s.match(/(\d{3,6})/) || ['0', '0'])[1], 10)
      return n(b) - n(a)
    })
  for (const dirName of dirs) {
    const base = join(BACKEND_DIR, dirName)
    const found = walkFor(base, targetNames, 0)
    if (found) return found
  }
  return null
}

function walkFor(dir: string, names: string[], depth: number): string | null {
  if (depth > 4) return null
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() && names.includes(e.name)) return join(dir, e.name)
    }
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const found = walkFor(join(dir, e.name), names, depth + 1)
        if (found) return found
      }
    }
  } catch {}
  return null
}

function findBackendBinaryByName(backendVersion: string): string | null {
  const base = join(BACKEND_DIR, backendVersion)
  if (!existsSync(base)) return null
  const targetNames = process.platform === 'win32' ? ['llama-server.exe', 'llama-server'] : ['llama-server']
  return walkFor(base, targetNames, 0)
}

function resolveSpawn(model: ModelEntry): ResolvedSpawn {
  const templates = readTemplates()
  // Match by absolute path so different templates pointing at the same file collapse.
  const match = templates.find(t => t.modelPath && resolve(t.modelPath) === resolve(model.path))
  const exe = (match?.backendVersion && findBackendBinaryByName(match.backendVersion)) || findLlamaServerBinary()
  if (!exe) throw new Error('No llama-server binary found in BACKEND_DIR. Install a backend in hexllama first.')

  const args: string[] = []
  const argMap: Record<string, string | number | boolean | null> = { ...(match?.args || {}) }
  // Force model path + port + no-webui regardless of what the template says,
  // since the router owns the slot.
  delete argMap['-m']; delete argMap['--model']
  delete argMap['--port']
  delete argMap['--no-webui']
  for (const [k, v] of Object.entries(argMap)) {
    if (v === true) args.push(k)
    else if (v !== false && v !== null && v !== undefined && v !== '') args.push(k, String(v))
  }
  if (!match) {
    // Defaults for ad-hoc models the user never built a card for. We use the
    // model's GGUF-declared context length, capped at MAX_CTX_DEFAULT so the
    // KV-cache budget stays sane.
    args.push('-ngl', '99', '-fa', '1', '-c', String(clampedCtx(model.nativeCtx)))
  }
  args.push('-m', model.path, '--port', String(LLAMA_SLOT_PORT), '--no-webui')
  return { exe, args, port: LLAMA_SLOT_PORT }
}

function writePidFile(pid: number): void {
  try { writeFileSync(PID_FILE, String(pid)) } catch {}
}
function clearPidFile(): void {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE) } catch {}
}
function killStaleLlamaFromPidFile(): void {
  if (!existsSync(PID_FILE)) return
  const raw = (() => { try { return readFileSync(PID_FILE, 'utf-8').trim() } catch { return '' } })()
  const pid = parseInt(raw, 10)
  if (!pid || Number.isNaN(pid)) { clearPidFile(); return }
  try {
    // signal 0 = check liveness without sending a signal
    process.kill(pid, 0)
    console.log(`[router] killing stale llama-server pid=${pid} (from previous run)`)
    process.kill(pid, 'SIGTERM')
    // Give it 2s to exit gracefully before SIGKILL.
    setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch {} }, 2000)
  } catch {
    // Process not alive — file is stale, just remove it.
  }
  clearPidFile()
}

async function killCurrent(): Promise<void> {
  const proc = state.currentProc
  if (!proc) return
  state.currentProc = null
  const wasModel = state.currentModelId
  state.currentModelId = null
  state.currentLlamaPort = null
  await new Promise<void>(done => {
    let resolved = false
    const finish = () => { if (!resolved) { resolved = true; done() } }
    proc.once('exit', finish)
    try { proc.kill() } catch {}
    setTimeout(() => { try { proc.kill('SIGKILL') } catch {}; finish() }, 5000)
  })
  console.log(`[router] stopped ${wasModel}`)
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise<boolean>(resolve => {
        const req = http.get(`http://127.0.0.1:${port}/health`, r => {
          resolve(r.statusCode === 200)
          r.resume()
        })
        req.on('error', () => resolve(false))
        req.setTimeout(2000, () => { req.destroy(); resolve(false) })
      })
      if (ok) return
    } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, HEALTH_POLL_MS))
  }
  throw new Error(`llama-server didn't become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`)
}

async function loadModel(modelId: string): Promise<void> {
  const entry = state.catalog.find(m => m.id === modelId)
  if (!entry) throw new Error(`Unknown model: ${modelId}`)
  const cfg = resolveSpawn(entry)
  console.log(`[router] loading ${modelId} (${basename(cfg.exe)}) ${cfg.args.join(' ')}`)
  const proc = spawn(cfg.exe, cfg.args, { cwd: dirname(cfg.exe), stdio: 'pipe' })
  proc.stderr?.on('data', d => process.stderr.write(`[router-llama] ${d}`))
  proc.stdout?.on('data', d => process.stdout.write(`[router-llama] ${d}`))
  proc.once('exit', code => {
    if (state.currentProc === proc) {
      state.currentProc = null
      state.currentModelId = null
      state.currentLlamaPort = null
      clearPidFile()
    }
    console.log(`[router] llama-server exited (code ${code})`)
  })
  state.currentProc = proc
  state.currentModelId = modelId
  state.currentLlamaPort = cfg.port
  if (proc.pid) writePidFile(proc.pid)
  await waitForHealth(cfg.port)
  console.log(`[router] ${modelId} ready on :${cfg.port}`)
}

async function ensureModelLoaded(modelId: string): Promise<void> {
  if (state.swapping) await state.swapping.catch(() => {})
  if (state.currentModelId === modelId && state.currentProc && !state.currentProc.killed) return
  state.swapping = (async () => {
    try {
      await killCurrent()
      await loadModel(modelId)
    } finally {
      state.swapping = null
    }
  })()
  await state.swapping
}

function serveCompletion(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks)
    let parsed: { model?: string }
    try { parsed = JSON.parse(raw.toString('utf-8')) }
    catch { return jsonResponse(res, 400, { error: { message: 'Request body must be JSON', type: 'invalid_request_error' } }) }

    const modelId = String(parsed.model || '').trim()
    if (!modelId) return jsonResponse(res, 400, { error: { message: '`model` field required', type: 'invalid_request_error' } })
    if (!state.catalog.find(m => m.id === modelId)) {
      return jsonResponse(res, 404, { error: { message: `Unknown model: ${modelId}. GET /v1/models for the catalog.`, type: 'invalid_request_error' } })
    }

    try {
      await ensureModelLoaded(modelId)
    } catch (err) {
      return jsonResponse(res, 500, { error: { message: `Failed to load ${modelId}: ${String(err)}`, type: 'server_error' } })
    }

    const port = state.currentLlamaPort
    if (!port) return jsonResponse(res, 500, { error: { message: 'No llama-server port after swap', type: 'server_error' } })

    // Forward request, stream response.
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(raw.length) }
    const auth = req.headers['authorization']
    if (typeof auth === 'string') headers['Authorization'] = auth
    const upstream = http.request({
      host: '127.0.0.1',
      port,
      path: req.url || '/',
      method: 'POST',
      headers
    }, upRes => {
      res.writeHead(upRes.statusCode || 502, { ...upRes.headers, 'Access-Control-Allow-Origin': '*' })
      upRes.pipe(res)
    })
    upstream.on('error', err => {
      if (!res.headersSent) jsonResponse(res, 502, { error: { message: `Upstream error: ${String(err)}`, type: 'server_error' } })
      else res.end()
    })
    upstream.end(raw)
  })
  req.on('error', err => {
    if (!res.headersSent) jsonResponse(res, 400, { error: { message: `Request error: ${String(err)}`, type: 'invalid_request_error' } })
  })
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    })
    return res.end()
  }

  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    return serveModels(res)
  }
  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/completions')) {
    return serveCompletion(req, res)
  }
  if (req.method === 'GET' && path === '/health') {
    return jsonResponse(res, 200, {
      ok: true,
      currentModelId: state.currentModelId,
      catalogSize: state.catalog.length
    })
  }
  notFound(res)
}

export async function startRouter(opts?: { port?: number }): Promise<void> {
  const settings = await loadSettings()
  // Default to enabled. Explicit `false` disables; anything else (including
  // `undefined` from never-set settings) keeps the router running.
  if (settings.piIntegration?.enabled === false) {
    console.log('[router] disabled in settings; skipping startup')
    return
  }
  state.port = opts?.port ?? settings.piIntegration?.port ?? DEFAULT_PORT
  // Kill any llama-server orphaned from a prior crash / dev hot-reload before
  // we accept new requests — otherwise the next swap will collide on :18080.
  killStaleLlamaFromPidFile()
  state.catalog = await scanModels()
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(handleRequest)
    server.once('error', reject)
    server.listen(state.port, '127.0.0.1', () => {
      state.server = server
      console.log(`[router] listening on http://127.0.0.1:${state.port} (catalog: ${state.catalog.length} models)`)
      resolve()
    })
  })
  await writePiConfig().catch(err => console.error('[router] pi config write failed:', err))
}

export async function stopRouter(): Promise<void> {
  if (state.currentProc) {
    try { state.currentProc.kill() } catch {}
    state.currentProc = null
  }
  clearPidFile()
  if (state.server) {
    await new Promise<void>(r => state.server!.close(() => r()))
    state.server = null
  }
}

export async function refreshCatalog(): Promise<ModelEntry[]> {
  state.catalog = await scanModels()
  // Pi config follows the catalog — keep them in sync.
  await writePiConfig().catch(err => console.error('[router] pi config write failed:', err))
  return state.catalog
}

const PI_CONFIG_PATH = join(os.homedir(), '.pi', 'agent', 'models.json')

interface PiModelEntry { id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }
interface PiProvider {
  baseUrl: string
  api: string
  apiKey: string
  compat?: Record<string, unknown>
  models: PiModelEntry[]
}
interface PiConfig { providers: Record<string, PiProvider> }

async function writePiConfig(): Promise<void> {
  let existing: PiConfig = { providers: {} }
  try {
    if (existsSync(PI_CONFIG_PATH)) {
      existing = JSON.parse(await fsPromises.readFile(PI_CONFIG_PATH, 'utf-8'))
      if (!existing.providers) existing.providers = {}
    }
  } catch {
    // Treat unreadable/corrupt config as empty rather than blowing up startup.
    existing = { providers: {} }
  }

  existing.providers.hexllama = {
    baseUrl: `http://localhost:${state.port}/v1`,
    api: 'openai-completions',
    apiKey: 'not-required',
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: state.catalog.map(m => ({
      id: m.id,
      // Reflects the actual ctx the router will spawn with — clamped to
      // MAX_CTX_DEFAULT so pi doesn't think it has more headroom than KV cache allows.
      contextWindow: clampedCtx(m.nativeCtx),
      maxTokens: 8192,
      reasoning: false
    }))
  }

  const dir = dirname(PI_CONFIG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await fsPromises.writeFile(PI_CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n')
  console.log(`[router] wrote pi config: ${state.catalog.length} models -> ${PI_CONFIG_PATH}`)
}

export function getRouterStatus() {
  return {
    listening: !!state.server,
    port: state.port,
    catalogSize: state.catalog.length,
    currentModelId: state.currentModelId
  }
}

// Re-export the path that templates live under so the swap logic in phase 2
// can look up a card for the requested model.
export const ROUTER_TEMPLATES_DIR = TEMPLATES_DIR
