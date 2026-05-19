import React, { useState, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { Gauge, Play, Loader2, AlertCircle } from 'lucide-react'

interface SweepParam { flag: string; label: string; placeholder: string }
const SWEEP_PARAMS: SweepParam[] = [
  { flag: '-t',    label: 'Threads',         placeholder: '4,6,8' },
  { flag: '-ngl',  label: 'GPU Layers',      placeholder: '99,30,0' },
  { flag: '-b',    label: 'Batch Size',      placeholder: '512,2048' },
  { flag: '-ub',   label: 'Micro-Batch',     placeholder: '256,512' },
  { flag: '-p',    label: 'Prompt Size',     placeholder: '128,512,1024' },
  { flag: '-n',    label: 'Gen Size',        placeholder: '32,128' },
  { flag: '-fa',   label: 'Flash Attn (0/1)', placeholder: '0,1' },
  { flag: '-ctk',  label: 'KV Cache K',      placeholder: 'f16,q8_0' },
  { flag: '-ctv',  label: 'KV Cache V',      placeholder: 'f16,q8_0' },
]

const TS_KEYS = ['avg_ts', 'stddev_ts']

function displayColumns(rows: Record<string, unknown>[]): string[] {
  if (!rows.length) return []
  const allKeys = Array.from(new Set(rows.flatMap(r => Object.keys(r))))
  const varying = allKeys.filter(k => new Set(rows.map(r => r[k])).size > 1)
  const cols = Array.from(new Set([...varying, ...TS_KEYS.filter(k => allKeys.includes(k))]))
  // tok/s columns last
  return cols.sort((a, b) => {
    const aTs = TS_KEYS.includes(a), bTs = TS_KEYS.includes(b)
    if (aTs && !bTs) return 1
    if (!aTs && bTs) return -1
    return 0
  })
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return String(v)
    if (Math.abs(v) >= 1000 || Number.isInteger(v)) return v.toLocaleString()
    return v.toFixed(2)
  }
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  const s = String(v)
  return s.length > 60 ? s.slice(0, 57) + '…' : s
}

export default function BenchmarkView() {
  const { models, backends, activeBackend } = useStore()
  const [modelPath, setModelPath] = useState('')
  const [backendName, setBackendName] = useState(activeBackend?.name || '')
  const [reps, setReps] = useState<number>(3)
  const [params, setParams] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [rows, setRows] = useState<Record<string, unknown>[]>([])
  const [error, setError] = useState('')

  const columns = useMemo(() => displayColumns(rows), [rows])

  async function handleRun() {
    setError(''); setRows([])
    const backend = backends.find(b => b.name === backendName) || activeBackend
    if (!backend) { setError('No backend selected.'); return }
    if (!modelPath) { setError('Select a model.'); return }
    setRunning(true)
    try {
      const res = await window.api.benchRun({
        backendPath: backend.path,
        backendExe: backend.exe || undefined,
        modelPath,
        reps,
        params
      })
      if (res.success) setRows(res.rows || [])
      else setError(res.error || 'Run failed')
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Benchmark</h1>
          <p className="page-subtitle">
            Sweep <code>llama-bench</code> parameters and compare performance
          </p>
        </div>
      </div>

      {/* Setup */}
      <div className="form-row" style={{ marginBottom: 20 }}>
        <div className="form-group">
          <label className="form-label">Model</label>
          <select
            className="form-select mono text-sm"
            value={modelPath}
            onChange={e => setModelPath(e.target.value)}
            disabled={running}
          >
            <option value="">-- Select a model --</option>
            {models.map(m => (
              <option key={m.path} value={m.path}>{m.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Backend</label>
          <select
            className="form-select"
            value={backendName}
            onChange={e => setBackendName(e.target.value)}
            disabled={running}
          >
            <option value="">{activeBackend ? `Default (${activeBackend.name})` : 'Default (Active)'}</option>
            {backends.map(b => (
              <option key={b.name} value={b.name}>{b.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Repetitions</label>
          <input
            type="number"
            className="form-input"
            value={reps}
            onChange={e => setReps(Number(e.target.value))}
            min={1} max={20} step="any"
            disabled={running}
          />
        </div>
      </div>

      {/* Sweep params */}
      <div className="settings-section">
        <div className="settings-section-title"><Gauge size={14} /> Sweep Parameters</div>
        <p className="form-hint" style={{ padding: '0 16px 12px', fontSize: 12 }}>
          Comma-separated values produce a sweep (e.g. <code>4,6,8</code>). Leave empty to use the
          default. Ranges like <code>1024-4096+1024</code> are also supported.
        </p>
        <div className="cmd-grid">
          {SWEEP_PARAMS.map(p => {
            const v = params[p.flag] || ''
            const isActive = v.trim().length > 0
            return (
              <div key={p.flag} className={`cmd-row ${isActive ? 'active-param' : ''}`}>
                <div className="cmd-label-group">
                  <div className="cmd-label">{p.label}</div>
                  <div className="cmd-arg">{p.flag}</div>
                </div>
                <div className="cmd-input-group">
                  <input
                    type="text"
                    className="cmd-input"
                    placeholder={p.placeholder}
                    value={v}
                    onChange={e => setParams({ ...params, [p.flag]: e.target.value })}
                    disabled={running}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={running || !modelPath}
        >
          {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
          {running ? 'Running benchmark…' : 'Run Benchmark'}
        </button>
        {running && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            This may take a few minutes depending on the sweep size.
          </span>
        )}
      </div>

      {error && (
        <div className="hub-error" style={{ marginTop: 16 }}>
          <AlertCircle size={14} /> <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{error}</span>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div className="settings-section-title" style={{ marginBottom: 12 }}>
            <Gauge size={14} /> Results ({rows.length} row{rows.length === 1 ? '' : 's'})
          </div>
          <div style={{
            overflowX: 'auto',
            border: '1.5px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--surface)'
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: 'var(--bg)', borderBottom: '1.5px solid var(--border)' }}>
                  {columns.map(k => (
                    <th key={k} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    {columns.map(k => (
                      <td key={k} style={{ padding: '6px 12px', whiteSpace: 'nowrap', fontFamily: TS_KEYS.includes(k) ? "'SF Mono','Fira Code',monospace" : undefined }}>
                        {formatCell(r[k])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
