import React, { useEffect } from 'react'
import { useStore } from './store/useStore'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import CardsView from './components/CardsView'
import SettingsView from './components/SettingsView'
import HuggingFaceView from './components/HuggingFaceView'
import ModelsView from './components/ModelsView'
import AboutView from './components/AboutView'
import CreateModal from './components/CreateModal'
import UpdateBanner from './components/UpdateBanner'
import type { Template } from '../../shared/types'

export default function App() {
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setLoading(false)
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  const {
    view,
    showCreateModal,
    backends,
    activeBackend,
    setBackends,
    setModels,
    setActiveBackend,
    setCommandsSchema,
    setCards,
    setPaths,
    setReleaseInfo,
    setCheckingUpdate
  } = useStore()
  useEffect(() => {
    async function init() {
      try {
        const [paths, backendsData, modelsData] = await Promise.all([
          window.api.getPaths(),
          window.api.listBackends(),
          window.api.listModels()
        ])
        setPaths(paths)
        setBackends(backendsData)
        setModels(modelsData)
        if (backendsData.length > 0) {
          setActiveBackend(backendsData[0])
          const cmds = await window.api.getCommands(backendsData[0].name)
          if (cmds) setCommandsSchema(cmds)
        } else {
          const cmds = await window.api.getCommands('')
          if (cmds) setCommandsSchema(cmds)
        }
        const templates = await window.api.listTemplates()
        setCards(
          (templates as Template[]).map((t) => ({
            template: t,
            status: 'idle',
            expanded: false
          }))
        )
      } catch (e) {
        console.error('Init error:', e)
      }
      checkUpdates()
    }
    init()
    window.api.onModelError((data) => {
      useStore.getState().setCardStatus(data.id, 'error')
      alert(`Model execution error:\n\n${data.error}`)
    })
  }, [])
  useEffect(() => {
    if (!activeBackend) return
    window.api.getCommands(activeBackend.name).then((cmds) => {
      if (cmds) setCommandsSchema(cmds)
    })
  }, [activeBackend, setCommandsSchema])
  useEffect(() => {
    window.api.onDownloadProgress((data) => {
      useStore.getState().setDownloadProgress(data)
    })
    return () => window.api.removeDownloadListener()
  }, [])
  async function checkUpdates() {
    setCheckingUpdate(true)
    try {
      const info = await window.api.checkUpdates()
      setReleaseInfo(info)
    } finally {
      setCheckingUpdate(false)
    }
  }
  function renderView() {
    if (view === 'hub') return <HuggingFaceView />
    if (view === 'settings') return <SettingsView />
    if (view === 'models') return <ModelsView />
    if (view === 'about') return <AboutView />
    return <CardsView />
  }
  if (loading) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 9999,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text)'
      }}>
        <img src="./icon.png" alt="Hexllama Icon" style={{ width: 128, height: 128, marginBottom: 24, imageRendering: 'crisp-edges' }} draggable={false} />
        <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '0.5px' }}>All AI-Glory to the Llama.cpp</h2>
      </div>
    )
  }

  return (
    <div className="app">
      <Titlebar onCheckUpdates={checkUpdates} />
      <UpdateBanner />
      <div className="main-layout">
        <Sidebar />
        <main className="content">
          {renderView()}
        </main>
      </div>
      {showCreateModal && <CreateModal />}
      
      <div 
        onClick={() => window.api.openExternal('https://andercoder.com')}
        style={{
          position: 'fixed', bottom: 16, right: 16, zIndex: 999, cursor: 'pointer',
          opacity: 0.5, transition: 'opacity 0.2s',
          filter: 'invert(1)'
        }}
        onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
        onMouseLeave={(e) => e.currentTarget.style.opacity = '0.5'}
        title="AnderCoder"
      >
        <img src="./logo-stroke.svg" alt="AnderCoder" style={{ height: 24, display: 'block' }} draggable={false} />
      </div>
    </div>
  )
}
