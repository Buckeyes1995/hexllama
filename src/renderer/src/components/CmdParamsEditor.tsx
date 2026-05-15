import React, { useMemo, useState } from 'react'
import { useStore } from '../store/useStore'
import { Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch, Search, Star } from 'lucide-react'
import type { CommandParam } from '../../../shared/types'
const iconMap: Record<string, React.ReactNode> = {
  Box: <Box size={14} />,
  Cpu: <Cpu size={14} />,
  Zap: <Zap size={14} />,
  Database: <Database size={14} />,
  Sliders: <Sliders size={14} />,
  Wind: <Wind size={14} />,
  Server: <Server size={14} />,
  FileText: <FileText size={14} />,
  GitBranch: <GitBranch size={14} />,
  Star: <Star size={14} />
}
const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']
interface Props {
  templateId?: string
  args: Record<string, any>
  onChange?: (args: Record<string, any>) => void
  modelPathFallback?: string
  serverPortFallback?: number
}
export default function CmdParamsEditor({ templateId, args, onChange, modelPathFallback, serverPortFallback }: Props) {
  const { commandsSchema, updateCard, cards } = useStore()
  const [searchQuery, setSearchQuery] = useState('')
  const cmdPreview = useMemo(() => {
    const parts: React.ReactNode[] = []
    parts.push(<span key="base">llama-server</span>)
    const card = templateId ? cards.find(c => c.template.id === templateId) : null
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) {
        parts.push(' ', <span key="arg-m" className="arg">-m</span>, ' ', <span key="val-m" className="val">"{finalModelPath}"</span>)
    }
    Object.entries(args).forEach(([key, val]) => {
      if (val === true) {
        parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>)
      } else if (val !== false && val !== null && val !== '') {
        parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>, ' ', <span key={`val-${key}`} className="val">{val}</span>)
      }
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && args['--port'] === undefined) {
         parts.push(' ', <span key="arg-port" className="arg">--port</span>, ' ', <span key="val-port" className="val">{finalPort}</span>)
    }
    return parts
  }, [args, cards, templateId, modelPathFallback, serverPortFallback])
  const filteredCategories = useMemo(() => {
    if (!commandsSchema) return []
    let allCommands: CommandParam[] = []
    commandsSchema.categories.forEach(cat => allCommands.push(...cat.commands))
    const q = searchQuery.toLowerCase()
    if (q) {
      return commandsSchema.categories.map(cat => ({
        ...cat,
        commands: cat.commands.filter(cmd => 
          cmd.label.toLowerCase().includes(q) || 
          cmd.arg.toLowerCase().includes(q) || 
          (cmd.short && cmd.short.toLowerCase().includes(q))
        )
      })).filter(cat => cat.commands.length > 0)
    }
    const featuredCommands = allCommands.filter(c => FEATURED_ARGS.includes(c.arg))
    const cats = commandsSchema.categories.map(cat => ({
      ...cat,
      commands: cat.commands.filter(c => !FEATURED_ARGS.includes(c.arg))
    })).filter(cat => cat.commands.length > 0)
    if (featuredCommands.length > 0) {
      featuredCommands.sort((a, b) => FEATURED_ARGS.indexOf(a.arg) - FEATURED_ARGS.indexOf(b.arg))
      cats.unshift({
        name: 'Main Settings',
        icon: 'Star',
        commands: featuredCommands
      })
    }
    return cats
  }, [commandsSchema, searchQuery])
  if (!commandsSchema) {
    return <div className="text-muted text-sm">No commands schema loaded. Ensure a backend is installed.</div>
  }
  const handleUpdate = (argName: string, value: any) => {
    const newArgs = { ...args }
    if (value === null || value === false || value === '') {
        delete newArgs[argName]
    } else {
        newArgs[argName] = value
    }
    if (onChange) {
        onChange(newArgs)
    } else if (templateId) {
        updateCard(templateId, { args: newArgs })
    }
  }
  const renderCommand = (cmd: CommandParam) => {
    if (cmd.arg === '--model' || cmd.arg === '--port') return null
    const val = args[cmd.arg] ?? (cmd.type === 'boolean' ? false : '')
    const isActive = args[cmd.arg] !== undefined && args[cmd.arg] !== false && args[cmd.arg] !== ''
    return (
      <div key={cmd.arg} className={`cmd-row ${isActive ? 'active-param' : ''} ${cmd.type === 'text' ? 'cmd-row-full' : ''}`}>
        <div className="cmd-label-group">
          <div className="cmd-label tooltip-wrap">
            {cmd.label}
            <span className="tooltip">{cmd.description}</span>
          </div>
          <div className="cmd-arg">{cmd.short ? `${cmd.short}, ` : ''}{cmd.arg}</div>
        </div>
        <div className="cmd-input-group">
          {cmd.type === 'boolean' && (
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!val} onChange={(e) => handleUpdate(cmd.arg, e.target.checked)} />
                <span className="toggle-track"></span>
                <span className="toggle-thumb"></span>
              </label>
            </div>
          )}
          {cmd.type === 'number' && (
            <div className="num-input-wrap">
              <button className="num-btn" onClick={() => handleUpdate(cmd.arg, Math.max((cmd.min ?? -Infinity), (Number(val) || 0) - 1))}>-</button>
              <input
                type="number" className="cmd-input num" value={val} placeholder={cmd.default?.toString()} min={cmd.min} max={cmd.max}
                onChange={(e) => handleUpdate(cmd.arg, e.target.value === '' ? '' : Number(e.target.value))}
              />
              <button className="num-btn" onClick={() => handleUpdate(cmd.arg, Math.min((cmd.max ?? Infinity), (Number(val) || 0) + 1))}>+</button>
            </div>
          )}
          {cmd.type === 'string' && (
            <input type="text" className="cmd-input" value={val} placeholder={cmd.placeholder || cmd.default?.toString()} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} />
          )}
          {cmd.type === 'select' && (
            <select className="cmd-select" value={val} onChange={(e) => handleUpdate(cmd.arg, e.target.value)}>
              <option value="">Default</option>
              {cmd.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
        </div>
        {cmd.type === 'text' && (
          <textarea className="cmd-textarea" value={val} placeholder={cmd.placeholder} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} />
        )}
      </div>
    )
  }
  return (
    <div className="params-editor-container">
      <div className="params-search-box">
        <Search size={16} style={{ color: 'var(--text-muted)' }} />
        <input 
          type="text" 
          className="form-input" 
          placeholder="Search parameters..." 
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="params-scroll-area">
        {filteredCategories.length === 0 ? (
           <div className="text-center py-6 text-sm text-muted">No parameters matched your search.</div>
        ) : (
          filteredCategories.map((cat) => (
            <div key={cat.name} className="cmd-section">
              <div className="cmd-section-header" style={cat.name === 'Main Settings' ? { color: 'var(--text)' } : {}}>
                {iconMap[cat.icon]} {cat.name}
              </div>
              <div className="cmd-grid">
                {cat.commands.map(renderCommand)}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="cmd-section" style={{ marginBottom: 0, marginTop: 16 }}>
        <div className="cmd-section-header">Preview</div>
        <div className="cmd-preview">
          {cmdPreview}
        </div>
      </div>
    </div>
  )
}
