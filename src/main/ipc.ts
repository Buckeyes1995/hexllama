import { ipcMain, dialog, shell } from 'electron'
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  unlinkSync, createWriteStream, statSync, rmdirSync, renameSync
} from 'fs'
import { join, extname, basename, dirname } from 'path'
import { spawn, ChildProcess } from 'child_process'
import https from 'https'
import http from 'http'
import { app } from 'electron'
import extract from 'extract-zip'
const APP_ROOT = app.isPackaged ? join(app.getPath('userData')) : join(process.cwd())
const MODELS_DIR    = join(APP_ROOT, 'models')
const TEMPLATES_DIR = join(APP_ROOT, 'templates')
const BACKEND_DIR   = join(APP_ROOT, 'backend')
for (const dir of [MODELS_DIR, TEMPLATES_DIR, BACKEND_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}
const runningProcesses = new Map<string, ChildProcess>()
interface DownloadTask {
  id: string          
  url: string
  filename: string
  destPath: string
  receivedBytes: number
  totalBytes: number
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  repoId?: string
  cancelFn?: () => void
}
const downloadTasks = new Map<string, DownloadTask>()
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'llamabox/1.0.0', Accept: 'application/json' } }
    const get = url.startsWith('https') ? https.get : http.get
    get(url, opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}
function startDownload(
  url: string,
  destPath: string,
  startByte: number,
  onProgress: (received: number, total: number) => void,
  onDone: () => void,
  onError: (err: Error) => void
): () => void {
  let destroyed = false
  let currentReq: ReturnType<typeof https.get> | null = null
  const isAppend = startByte > 0
  const file = isAppend
    ? createWriteStream(destPath, { flags: 'a' })
    : createWriteStream(destPath)
  const attempt = (currentUrl: string) => {
    const get = currentUrl.startsWith('https') ? https.get : http.get
    const headers: Record<string, string> = { 'User-Agent': 'llamabox/1.0.0' }
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`
    currentReq = get(currentUrl, { headers }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return attempt(res.headers.location!)
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        file.close()
        if (!destroyed) onError(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const contentLength = parseInt(res.headers['content-length'] || '0', 10)
      const totalBytes = contentLength + startByte
      let receivedBytes = startByte
      res.on('data', (chunk) => {
        receivedBytes += chunk.length
        onProgress(receivedBytes, totalBytes)
      })
      res.pipe(file)
      file.on('finish', () => { file.close(); if (!destroyed) onDone() })
      res.on('error', (err) => { file.close(); if (!destroyed) onError(err) })
    }).on('error', (err) => { file.close(); if (!destroyed) onError(err) })
  }
  attempt(url)
  return () => {
    destroyed = true
    currentReq?.destroy()
    file.close()
  }
}
export function registerIpcHandlers(): void {
  ipcMain.handle('list-models', () => {
    if (!existsSync(MODELS_DIR)) return []
    const exts = ['.gguf', '.bin', '.ggml']
    const results: { name: string; path: string; size: number; folder: string }[] = []
    const scan = (dir: string) => {
      try {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) scan(join(dir, e.name))
          else if (exts.includes(extname(e.name).toLowerCase())) {
            const fp = join(dir, e.name)
            results.push({ name: e.name, path: fp, size: statSync(fp).size, folder: basename(dir) })
          }
        }
      } catch {}
    }
    scan(MODELS_DIR)
    return results
  })
  ipcMain.handle('delete-model', (_e, filePath: string) => {
    try {
      unlinkSync(filePath)
      const dir = dirname(filePath)
      if (dir !== MODELS_DIR) {
        try { if (readdirSync(dir).length === 0) rmdirSync(dir) } catch {}
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('rename-model', (_e, oldPath: string, newName: string) => {
    try {
      const dir = dirname(oldPath)
      const newPath = join(dir, newName + extname(oldPath))
      renameSync(oldPath, newPath)
      return { success: true, newPath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('start-model-download', (event, opts: {
    url: string
    filename: string
    repoId?: string
    modelFolder?: string   
  }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const t = downloadTasks.get(id)!
      if (t.phase === 'downloading') return { success: false, error: 'Already downloading' }
    }
    const folder = opts.modelFolder || opts.repoId?.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, opts.filename)
    const task: DownloadTask = {
      id, url: opts.url, filename: opts.filename,
      destPath, receivedBytes: 0, totalBytes: 0,
      phase: 'downloading', repoId: opts.repoId
    }
    const emit = (t: DownloadTask) =>
      event.sender.send('model-download-progress', {
        id: t.id, filename: t.filename, percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0,
        receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, phase: t.phase, destPath: t.destPath
      })
    task.cancelFn = startDownload(
      opts.url, destPath, 0,
      (received, total) => {
        task.receivedBytes = received; task.totalBytes = total
        emit(task)
      },
      () => {
        task.phase = 'done'; emit(task)
        setTimeout(() => downloadTasks.delete(id), 5000)
      },
      (err) => {
        task.phase = 'error'; emit(task)
        console.error('Download error:', err)
      }
    )
    downloadTasks.set(id, task)
    emit(task)
    return { success: true, id }
  })
  ipcMain.handle('pause-model-download', (event, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'downloading') return { success: false, error: 'Not downloading' }
    task.cancelFn?.()
    task.phase = 'paused'
    event.sender.send('model-download-progress', { id, filename: task.filename, phase: 'paused', percent: task.totalBytes > 0 ? Math.round((task.receivedBytes / task.totalBytes) * 100) : 0, receivedBytes: task.receivedBytes, totalBytes: task.totalBytes })
    return { success: true }
  })
  ipcMain.handle('resume-model-download', (event, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'paused') return { success: false, error: 'Not paused' }
    task.phase = 'downloading'
    const emit = (t: DownloadTask) =>
      event.sender.send('model-download-progress', {
        id: t.id, filename: t.filename, phase: t.phase,
        percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0,
        receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, destPath: t.destPath
      })
    const startByte = task.receivedBytes
    task.cancelFn = startDownload(
      task.url, task.destPath, startByte,
      (received, total) => { task.receivedBytes = received; task.totalBytes = total; emit(task) },
      () => { task.phase = 'done'; emit(task); setTimeout(() => downloadTasks.delete(id), 5000) },
      (err) => { task.phase = 'error'; emit(task); console.error('Resume error:', err) }
    )
    emit(task)
    return { success: true }
  })
  ipcMain.handle('cancel-model-download', (event, id: string) => {
    const task = downloadTasks.get(id)
    if (!task) return { success: false, error: 'Not found' }
    task.cancelFn?.()
    task.phase = 'cancelled'
    try { unlinkSync(task.destPath) } catch {}
    event.sender.send('model-download-progress', { id, filename: task.filename, phase: 'cancelled', percent: 0, receivedBytes: 0, totalBytes: 0 })
    downloadTasks.delete(id)
    return { success: true }
  })
  ipcMain.handle('list-model-downloads', () => {
    return Array.from(downloadTasks.values()).map(t => ({
      id: t.id, url: t.url, filename: t.filename, destPath: t.destPath,
      receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, phase: t.phase,
      percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0
    }))
  })
  ipcMain.handle('list-backends', () => {
    if (!existsSync(BACKEND_DIR)) return []
    const findExecutable = (dir: string, depth = 0): string | null => {
      if (depth > 3) return null
      try {
        const files = readdirSync(dir, { withFileTypes: true })
        const names = process.platform === 'win32'
          ? ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server']
          : ['llama-server', 'main', 'server']
        for (const f of files) {
          if (!f.isDirectory() && names.includes(f.name.toLowerCase())) return f.name
        }
        for (const f of files) {
          if (f.isDirectory()) {
            const sub = findExecutable(join(dir, f.name), depth + 1)
            if (sub) return join(f.name, sub)
          }
        }
      } catch {}
      return null
    }
    const backends = readdirSync(BACKEND_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => {
        const commandsPath = join(BACKEND_DIR, d.name, 'commands.json')
        const basePath = join(BACKEND_DIR, d.name)
        return { name: d.name, path: basePath, hasCommands: existsSync(commandsPath), exe: findExecutable(basePath) }
      })
    backends.sort((a, b) => {
      const n = (s: string) => parseInt((s.match(/(\d{3,6})/) || ['0', '0'])[1], 10)
      return n(b.name) - n(a.name)
    })
    return backends
  })
  ipcMain.handle('delete-backend', (_e, backendName: string) => {
    try {
      const backendPath = join(BACKEND_DIR, backendName)
      const rm = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name)
          e.isDirectory() ? rm(p) : unlinkSync(p)
        }
        rmdirSync(dir)
      }
      rm(backendPath)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('get-commands', (_e, backendName: string) => {
    const commandsPath = join(BACKEND_DIR, backendName, 'commands.json')
    if (existsSync(commandsPath)) return JSON.parse(readFileSync(commandsPath, 'utf-8'))
    const defaultPath = join(APP_ROOT, 'resources', 'commands.json')
    if (existsSync(defaultPath)) return JSON.parse(readFileSync(defaultPath, 'utf-8'))
    return null
  })
  ipcMain.handle('save-backend-commands', (_e, backendName: string, schema: unknown) => {
    try {
      const backendPath = join(BACKEND_DIR, backendName)
      if (!existsSync(backendPath)) mkdirSync(backendPath, { recursive: true })
      writeFileSync(join(backendPath, 'commands.json'), JSON.stringify(schema, null, 2))
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('list-templates', () => {
    if (!existsSync(TEMPLATES_DIR)) return []
    return readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return { ...JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8')), _file: f } }
        catch { return null }
      })
      .filter(Boolean)
  })
  ipcMain.handle('save-template', (_e, template: Record<string, unknown>) => {
    const id = (template.id as string) || Date.now().toString()
    writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify({ ...template, id }, null, 2))
    return { success: true, id }
  })
  ipcMain.handle('delete-template', (_e, id: string) => {
    const fp = join(TEMPLATES_DIR, `${id}.json`)
    if (existsSync(fp)) unlinkSync(fp)
    return { success: true }
  })
  ipcMain.handle('import-template', async () => {
    const r = await dialog.showOpenDialog({ title: 'Import Template', filters: [{ name: 'JSON Template', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return null
    const data = JSON.parse(readFileSync(r.filePaths[0], 'utf-8'))
    const id = Date.now().toString(); data.id = id
    writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(data, null, 2))
    return data
  })
  ipcMain.handle('export-template', async (_e, template: Record<string, unknown>) => {
    const r = await dialog.showSaveDialog({ title: 'Export Template', defaultPath: `${template.name ?? 'template'}.json`, filters: [{ name: 'JSON Template', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return { success: false }
    writeFileSync(r.filePath, JSON.stringify(template, null, 2)); return { success: true }
  })
  ipcMain.handle('pick-model-file', async () => {
    const r = await dialog.showOpenDialog({ title: 'Select Model File', filters: [{ name: 'GGUF / GGML Models', extensions: ['gguf', 'bin', 'ggml'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return null
    return { name: basename(r.filePaths[0]), path: r.filePaths[0] }
  })
  ipcMain.handle('run-model', (_e, opts: { id: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number }) => {
    if (runningProcesses.has(opts.id)) return { success: false, error: 'Already running' }
    const exePath = join(opts.backendPath, opts.exe)
    if (!existsSync(exePath)) return { success: false, error: `Executable not found: ${exePath}` }
    try {
      const proc = spawn(exePath, opts.args, { detached: false, stdio: 'pipe', cwd: dirname(exePath), windowsHide: false })
      proc.stderr?.on('data', (d) => console.error('[llama-server]', d.toString()))
      proc.stdout?.on('data', (d) => console.log('[llama-server]', d.toString()))
      proc.on('error', (err: any) => {
        let msg = String(err)
        if (err.code === 'UNKNOWN' && opts.backendPath.toLowerCase().includes('arm64') && process.arch !== 'arm64') {
          msg = 'Architecture mismatch: You are trying to run an ARM64 backend on an x64 system. Please delete this backend in Settings and download the x64 version.'
        }
        console.error('[llama-server] spawn error:', msg)
        runningProcesses.delete(opts.id)
        _e.sender.send('model-error', { id: opts.id, error: msg })
      })
      runningProcesses.set(opts.id, proc)
      proc.on('exit', () => runningProcesses.delete(opts.id))
      if (opts.openBrowser) setTimeout(() => shell.openExternal(`http://127.0.0.1:${opts.port}`), 2500)
      return { success: true, pid: proc.pid }
    } catch (err: any) {
      if (err.code === 'UNKNOWN' && opts.backendPath.toLowerCase().includes('arm64') && process.arch !== 'arm64') {
        return { success: false, error: 'Architecture mismatch: You are trying to run an ARM64 backend on an x64 system. Please delete this backend in Settings and download the x64 version.' }
      }
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('stop-model', (_e, id: string) => {
    const proc = runningProcesses.get(id)
    if (!proc) return { success: false, error: 'Not running' }
    proc.kill(); runningProcesses.delete(id)
    return { success: true }
  })
  ipcMain.handle('check-updates', async () => {
    try {
      const release = await fetchJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest') as any
      const windowsAssets = release.assets.filter((a: any) => {
        const lowerName = a.name.toLowerCase()
        const isWin = lowerName.endsWith('.zip') && !lowerName.startsWith('cudart-') && (lowerName.includes('win') || lowerName.includes('windows'))
        if (!isWin) return false
        if (process.arch === 'x64' && lowerName.includes('arm64')) return false
        if (process.arch === 'arm64' && lowerName.includes('x64')) return false
        return true
      })
      const latestNum = parseInt(release.tag_name.replace(/^b/, ''), 10)
      let isNewer = true
      if (existsSync(BACKEND_DIR)) {
        for (const d of readdirSync(BACKEND_DIR, { withFileTypes: true }).filter(d => d.isDirectory())) {
          const m = d.name.match(/(\d{3,6})/); if (!m) continue
          if (parseInt(m[1], 10) >= latestNum || d.name.includes(release.tag_name)) { isNewer = false; break }
        }
      }
      return { tagName: release.tag_name, name: release.name, url: release.html_url, publishedAt: release.published_at, isNewer, assets: windowsAssets.map((a: any) => ({ name: a.name, downloadUrl: a.browser_download_url, size: a.size })) }
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('download-release', async (event, opts: { url: string; version: string; assetName: string }) => {
    const zipPath = join(app.getPath('temp'), opts.assetName)
    const extractPath = join(BACKEND_DIR, opts.version)
    try {
      event.sender.send('download-progress', { percent: 0, phase: 'downloading' })
      await new Promise<void>((resolve, reject) => {
        const cancel = startDownload(opts.url, zipPath, 0,
          (r, t) => event.sender.send('download-progress', { percent: t > 0 ? Math.round(r / t * 100) : 0, phase: 'downloading' }),
          resolve, reject)
        void cancel
      })
      event.sender.send('download-progress', { percent: 100, phase: 'extracting' })
      if (!existsSync(extractPath)) mkdirSync(extractPath, { recursive: true })
      await extract(zipPath, { dir: extractPath })
      try { unlinkSync(zipPath) } catch {}
      return { success: true, path: extractPath }
    } catch (err) { return { success: false, error: String(err) } }
  })
  ipcMain.handle('open-folder', (_e, folderPath: string) => shell.openPath(folderPath))
  ipcMain.handle('get-paths', () => ({ models: MODELS_DIR, templates: TEMPLATES_DIR, backend: BACKEND_DIR }))
  ipcMain.handle('open-external', (_e, url: string) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url)
    }
  })
  ipcMain.handle('hf-search', async (_e, query: string) => {
    try {
      const data = await fetchJson(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=24&sort=downloads&direction=-1`) as any[]
      return data.map(m => ({ id: m.id, author: m.author || m.id.split('/')[0] || '', name: m.id.split('/').pop() || m.id, downloads: m.downloads || 0, likes: m.likes || 0, tags: m.tags || [], lastModified: m.lastModified || '' }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-get-files', async (_e, repoId: string) => {
    try {
      const data = await fetchJson(`https://huggingface.co/api/models/${repoId}`) as any
      return (data.siblings || []).filter((f: any) => f.rfilename.endsWith('.gguf')).map((f: any) => ({ name: f.rfilename, size: f.size || 0, downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${f.rfilename}` }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-download-model', (event, opts: { repoId: string; filename: string; downloadUrl: string }) => {
    const id = opts.filename
    const folder = opts.repoId.split('/').pop() || 'downloads'
    const destDir = join(MODELS_DIR, folder)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const destPath = join(destDir, opts.filename)
    const task: DownloadTask = { id, url: opts.downloadUrl, filename: opts.filename, destPath, receivedBytes: 0, totalBytes: 0, phase: 'downloading', repoId: opts.repoId }
    const emit = () => event.sender.send('hf-download-progress', {
      percent: task.totalBytes > 0 ? Math.round(task.receivedBytes / task.totalBytes * 100) : 0,
      phase: task.phase,
      filename: task.filename,
      destPath: task.destPath
    })
    task.cancelFn = startDownload(
      opts.downloadUrl, destPath, 0,
      (r, t) => { task.receivedBytes = r; task.totalBytes = t; emit() },
      () => { task.phase = 'done'; emit(); setTimeout(() => downloadTasks.delete(id), 5000) },
      (err) => { task.phase = 'error'; emit(); console.error('HF download error:', err) }
    )
    downloadTasks.set(id, task)
    return { success: true }
  })
  ipcMain.handle('hf-open-models-dir', () => shell.openPath(MODELS_DIR))
  ipcMain.handle('onDownloadProgress', () => {})
  ipcMain.handle('removeDownloadListener', () => {})
}
