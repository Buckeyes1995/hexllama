import React from 'react'
import { ExternalLink, Info, ShieldAlert, FileText, Heart } from 'lucide-react'
export default function AboutView() {
  const openLink = (url: string) => {
    window.api.openExternal(url)
  }
  return (
    <div className="about-container" style={{ padding: 24, maxWidth: 800, margin: '0 auto', color: 'var(--text)' }}>
      <div className="page-header" style={{ marginBottom: 32 }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img src="./full-logo.png" alt="hexllama" style={{ height: 32, imageRendering: 'crisp-edges' }} draggable={false} />
          </h1>
          <p className="page-subtitle">A fast, beautiful GUI for managing local LLMs</p>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {}
        <section className="about-section">
          <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Heart size={16} style={{ color: 'var(--danger)' }} /> Acknowledgements
          </h2>
          <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
            <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
              This project only exists because of <strong>llama.cpp</strong> created by <strong>Georgi Gerganov</strong>. 
              Please consider supporting the incredible work done by the llama.cpp community.
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/ggerganov')}>
                <ExternalLink size={14} /> @ggerganov
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/ggml-org')}>
                <ExternalLink size={14} /> ggml-org
              </button>
            </div>
          </div>
        </section>
        {}
        <section className="about-section">
          <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Info size={16} /> About the Developer
          </h2>
          <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20 }}>
            <p style={{ marginBottom: 16, lineHeight: 1.6 }}>
              <strong>Hexllama</strong> was developed by <strong>Anderson Nascimento</strong>, a Brazilian software engineer who loves the (admittedly expensive) fascinating hobby of local AI.
            </p>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/andersondanieln')}>
                <ExternalLink size={14} /> GitHub
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://github.com/andersondanieln/hexllama')}>
                <ExternalLink size={14} /> Repository
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://www.linkedin.com/in/andersondn')}>
                <ExternalLink size={14} /> LinkedIn
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => openLink('https://andercoder.com/hexllama')}>
                <ExternalLink size={14} /> Website
              </button>
            </div>
          </div>
        </section>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {}
          <section className="about-section">
            <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <FileText size={16} /> Terms of Use
            </h2>
            <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20, height: '100%', fontSize: 13, color: 'var(--text-secondary)' }}>
              <p style={{ lineHeight: 1.6 }}>
                This software is provided <strong>"as is"</strong>, without warranty of any kind, express or implied. 
                In no event shall the authors or copyright holders be liable for any claim, damages or other liability, 
                whether in an action of contract, tort or otherwise, arising from, out of or in connection with the 
                software or the use or other dealings in the software.
              </p>
            </div>
          </section>
          {}
          <section className="about-section">
            <h2 style={{ fontSize: 16, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <ShieldAlert size={16} /> Privacy Policy
            </h2>
            <div className="about-card" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 20, height: '100%', fontSize: 13, color: 'var(--text-secondary)' }}>
              <p style={{ lineHeight: 1.6 }}>
                <strong>Hexllama does not collect or transmit any user data.</strong> There is absolutely no telemetry, tracking, or analytics built into this application.
                <br /><br />
                However, please be aware that downloading models or executing third-party binaries (such as Hugging Face APIs or the llama.cpp executables) may be subject to their respective privacy policies.
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
