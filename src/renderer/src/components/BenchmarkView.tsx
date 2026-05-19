import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { Gauge, Play, Loader2, AlertCircle, ExternalLink, Copy, Check, ChevronDown } from 'lucide-react'

interface SweepParam {
  flag: string
  label: string
  placeholder: string
  defaultValue: string
  validValues: string  // shown after the flag so users know what they can type
  choices?: string[]   // common values shown in the pick-menu next to the input
}
// `defaultValue` is what llama-bench uses when the flag isn't passed (per its --help).
// `validValues` is a short description of the allowed input range or enumeration.
// `choices` populates a checkbox dropdown next to the input -- ticking values
// rebuilds the comma list automatically so users don't have to type quant names etc.
const KV_TYPES = ['f16', 'f32', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1']
const SWEEP_PARAMS: SweepParam[] = [
  { flag: '-t',    label: 'Threads',     placeholder: 'e.g. 4,6,8',    defaultValue: '8',    validValues: '1..256',                                                                                  choices: ['2', '4', '6', '8', '10', '12'] },
  { flag: '-ngl',  label: 'GPU Layers',  placeholder: 'e.g. 99,30,0',  defaultValue: '99',   validValues: '0..99 (all)',                                                                              choices: ['0', '16', '32', '64', '99'] },
  { flag: '-b',    label: 'Batch Size',  placeholder: 'e.g. 512,2048', defaultValue: '2048', validValues: '1..65536',                                                                                 choices: ['128', '256', '512', '1024', '2048', '4096'] },
  { flag: '-ub',   label: 'Micro-Batch', placeholder: 'e.g. 256,512',  defaultValue: '512',  validValues: '1..65536, ≤ batch',                                                                        choices: ['64', '128', '256', '512', '1024'] },
  { flag: '-p',    label: 'Prompt Size', placeholder: 'e.g. 128,1024', defaultValue: '512',  validValues: '≥ 0',                                                                                     choices: ['0', '128', '256', '512', '1024', '2048', '4096'] },
  { flag: '-n',    label: 'Gen Size',    placeholder: 'e.g. 32,64',    defaultValue: '128',  validValues: '≥ 0',                                                                                     choices: ['0', '32', '64', '128', '256', '512'] },
  { flag: '-fa',   label: 'Flash Attn',  placeholder: 'e.g. 0,1',      defaultValue: '0',    validValues: '0 | 1 — required = 1 for any non-f16/f32/bf16 KV cache type',                              choices: ['0', '1'] },
  { flag: '-ctk',  label: 'KV Cache K',  placeholder: 'e.g. f16,q8_0', defaultValue: 'f16',  validValues: 'f16 | f32 | bf16 — and (with -fa 1) q8_0 | q4_0 | q4_1 | iq4_nl | q5_0 | q5_1',             choices: KV_TYPES },
  { flag: '-ctv',  label: 'KV Cache V',  placeholder: 'e.g. f16,q8_0', defaultValue: 'f16',  validValues: 'f16 | f32 | bf16 — and (with -fa 1) q8_0 | q4_0 | q4_1 | iq4_nl | q5_0 | q5_1',             choices: KV_TYPES },
]

function MultiChoiceMenu({ choices, value, onChange, disabled }: {
  choices: string[]
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = new Set(value.split(',').map(s => s.trim()).filter(Boolean))
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  function toggle(v: string) {
    const next = new Set(selected)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange(choices.filter(c => next.has(c)).join(','))
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title="Pick common values"
        style={{ padding: 4 }}
      >
        <ChevronDown size={14} />
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 4px)',
          right: 0,
          minWidth: 140,
          background: 'var(--surface)',
          border: '1.5px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-md)',
          zIndex: 50,
          padding: 4
        }}>
          {choices.map(c => (
            <label
              key={c}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '5px 10px',
                cursor: 'pointer',
                fontSize: 12,
                borderRadius: 4,
                userSelect: 'none'
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg)')}
              onMouseLeave={e => (e.currentTarget.style.background = '')}
            >
              <input
                type="checkbox"
                checked={selected.has(c)}
                onChange={() => toggle(c)}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontFamily: "'SF Mono','Fira Code',monospace" }}>{c}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
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
  const [progressLines, setProgressLines] = useState<string[]>([])
  const [elapsed, setElapsed] = useState(0)
  const [errorCopied, setErrorCopied] = useState(false)
  const startedAt = useRef<number>(0)

  useEffect(() => {
    if (typeof window.api.onBenchProgress !== 'function') return
    window.api.onBenchProgress(({ line }) => {
      setProgressLines(prev => {
        // keep the last 12 lines so we have context for the failure
        const next = [...prev, line]
        return next.length > 12 ? next.slice(next.length - 12) : next
      })
    })
    return () => window.api.removeBenchProgressListener?.()
  }, [])

  useEffect(() => {
    if (!running) return
    startedAt.current = Date.now()
    setElapsed(0)
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 500)
    return () => clearInterval(t)
  }, [running])

  // Detect the most common llama-bench config trap: quantized KV cache without
  // Flash Attention enabled. llama.cpp refuses context init with that combo.
  const kvFaWarning = (() => {
    const FA_REQUIRED = /^(q8_0|q4_0|q4_1|iq4_nl|q5_0|q5_1)$/
    const sweep = (s: string) => s.split(',').map(t => t.trim()).filter(Boolean)
    const ctkVals = sweep(params['-ctk'] || '')
    const ctvVals = sweep(params['-ctv'] || '')
    const usesQuantKV = [...ctkVals, ...ctvVals].some(v => FA_REQUIRED.test(v))
    if (!usesQuantKV) return null
    const faVals = sweep(params['-fa'] || '')
    // OK if all FA values are exactly "1". (If sweep includes both 0 and 1, fa=0 runs will fail.)
    const allFaOne = faVals.length > 0 && faVals.every(v => v === '1')
    if (allFaOne) return null
    return 'Quantized KV cache types (q4_*, q5_*, q8_0, iq4_nl) require Flash Attn = 1. Set the Flash Attn field to "1" (or include "1" in the sweep — but "0" runs against these KV types will fail).'
  })()

  async function handleRun() {
    setError(''); setRows([]); setProgressLines([])
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
          Comma-separated values produce a sweep (e.g. <code>4,6,8</code>). Leave a field empty to
          use llama-bench's single-value default (shown next to each label). Ranges like
          <code>1024-4096+1024</code> are also supported.
        </p>
        <div className="cmd-grid">
          {SWEEP_PARAMS.map(p => {
            const v = params[p.flag] || ''
            const isActive = v.trim().length > 0
            return (
              <div key={p.flag} className={`cmd-row ${isActive ? 'active-param' : ''}`}>
                <div className="cmd-label-group">
                  <div className="cmd-label">
                    {p.label}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11, marginLeft: 8 }}>
                      default: <span className="mono">{p.defaultValue}</span>
                    </span>
                  </div>
                  <div className="cmd-arg">
                    {p.flag}
                    <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 400 }}>
                      ({p.validValues})
                    </span>
                  </div>
                </div>
                <div className="cmd-input-group" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    className="cmd-input"
                    placeholder={p.placeholder}
                    value={v}
                    onChange={e => setParams({ ...params, [p.flag]: e.target.value })}
                    disabled={running}
                    style={{ flex: 1 }}
                  />
                  {p.choices && (
                    <MultiChoiceMenu
                      choices={p.choices}
                      value={v}
                      onChange={next => setParams({ ...params, [p.flag]: next })}
                      disabled={running}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {kvFaWarning && (
        <div
          style={{
            marginTop: 16,
            padding: '10px 14px',
            background: 'rgba(217,119,6,0.08)',
            border: '1.5px solid rgba(217,119,6,0.35)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--warning)',
            fontSize: 12,
            lineHeight: 1.5
          }}
        >
          ⚠ {kvFaWarning}
        </div>
      )}

      <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button
          className="btn btn-primary"
          onClick={handleRun}
          disabled={running || !modelPath}
          title={!modelPath ? 'Select a model first' : (running ? 'Benchmark in progress' : '')}
        >
          {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
          {running ? 'Running benchmark…' : 'Run Benchmark'}
        </button>
        {!running && !modelPath && (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Select a model above to enable.
          </span>
        )}
      </div>

      {running && (() => {
        // Build a one-line summary of the active sweep so the user can see
        // *what's being swept* when a failure mid-run kills the run.
        const sweepSummary = SWEEP_PARAMS
          .map(p => {
            const v = (params[p.flag] || '').trim()
            return v ? `${p.flag} { ${v} }` : null
          })
          .filter(Boolean)
          .join(' · ')
        const latest = progressLines[progressLines.length - 1] || 'Loading model…'
        const recent = progressLines.slice(-4)
        return (
          <div
            style={{
              position: 'sticky',
              bottom: 16,
              zIndex: 999,
              marginTop: 16,
              padding: '12px 14px',
              background: 'var(--surface)',
              border: '1.5px solid var(--accent)',
              borderRadius: 'var(--radius-sm)',
              boxShadow: 'var(--shadow-md)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <Loader2 size={16} className="spin" style={{ flexShrink: 0, color: 'var(--accent)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {latest}
                </div>
                <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: 'var(--text-secondary)' }}>
                  {Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, '0')}s elapsed
                </div>
              </div>
            </div>
            {sweepSummary && (
              <div style={{
                marginTop: 6,
                padding: '6px 10px',
                background: 'var(--bg)',
                borderRadius: 6,
                fontSize: 11,
                color: 'var(--text-secondary)',
                fontFamily: "'SF Mono','Fira Code',monospace",
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}>
                <span style={{ color: 'var(--text-muted)' }}>Sweep:</span> {sweepSummary}
              </div>
            )}
            {recent.length > 1 && (
              <div style={{
                marginTop: 8,
                padding: '6px 10px',
                background: 'var(--bg)',
                borderRadius: 6,
                fontSize: 11,
                color: 'var(--text-secondary)',
                fontFamily: "'SF Mono','Fira Code',monospace",
                maxHeight: 90,
                overflow: 'auto',
                userSelect: 'text',
                WebkitUserSelect: 'text'
              } as React.CSSProperties}>
                {recent.map((l, i) => (
                  <div key={i} style={{
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    opacity: i === recent.length - 1 ? 1 : 0.55
                  }}>
                    {l}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {error && (() => {
        const sweepSummary = SWEEP_PARAMS
          .map(p => {
            const v = (params[p.flag] || '').trim()
            return v ? `${p.flag} { ${v} }` : null
          })
          .filter(Boolean)
          .join(' · ')
        const lastFew = progressLines.slice(-6)
        const fullCopy =
          (sweepSummary ? `Sweep: ${sweepSummary}\n\n` : '') +
          (lastFew.length ? `Last lines before failure:\n${lastFew.join('\n')}\n\n` : '') +
          error
        return (
          <div
            className="hub-error"
            style={{
              marginTop: 16,
              alignItems: 'flex-start',
              gap: 10,
              padding: '12px 14px',
              flexDirection: 'column'
            } as React.CSSProperties}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%' }}>
              <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
              <pre
                style={{
                  flex: 1,
                  margin: 0,
                  fontFamily: "'SF Mono','Fira Code',monospace",
                  fontSize: 12,
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  userSelect: 'text',
                  WebkitUserSelect: 'text',
                  cursor: 'text'
                } as React.CSSProperties}
              >
                {error}
              </pre>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  navigator.clipboard.writeText(fullCopy)
                  setErrorCopied(true)
                  setTimeout(() => setErrorCopied(false), 1500)
                }}
                title="Copy error + sweep + recent log"
                style={{ flexShrink: 0, padding: 6 }}
              >
                {errorCopied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
            {sweepSummary && (
              <div style={{
                width: '100%',
                marginTop: 4,
                padding: '8px 10px',
                background: 'rgba(0,0,0,0.04)',
                borderRadius: 6,
                fontSize: 11,
                fontFamily: "'SF Mono','Fira Code',monospace",
                color: 'var(--text)',
                userSelect: 'text',
                WebkitUserSelect: 'text',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              } as React.CSSProperties}>
                <span style={{ opacity: 0.6 }}>Sweep at time of failure:</span> {sweepSummary}
              </div>
            )}
            {lastFew.length > 0 && (
              <div style={{
                width: '100%',
                padding: '8px 10px',
                background: 'rgba(0,0,0,0.04)',
                borderRadius: 6,
                fontSize: 11,
                fontFamily: "'SF Mono','Fira Code',monospace",
                color: 'var(--text-secondary)',
                userSelect: 'text',
                WebkitUserSelect: 'text',
                maxHeight: 140,
                overflow: 'auto'
              } as React.CSSProperties}>
                <div style={{ opacity: 0.6, marginBottom: 4 }}>Last {lastFew.length} llama-bench lines:</div>
                {lastFew.map((l, i) => <div key={i} style={{ whiteSpace: 'pre-wrap' }}>{l}</div>)}
              </div>
            )}
          </div>
        )
      })()}

      {rows.length > 0 && (
        <div
          style={{
            marginTop: 24,
            padding: '16px 18px',
            background: 'var(--surface)',
            border: '1.5px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {rows.length} result{rows.length === 1 ? '' : 's'} ready
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              Open the results window to view the table and export to Markdown or PDF.
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => window.api.benchShowResults(rows)}
          >
            <ExternalLink size={14} /> Open Results Window
          </button>
        </div>
      )}
    </div>
  )
}
