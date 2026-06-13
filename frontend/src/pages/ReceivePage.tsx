import { useState } from 'react'

interface FileRequest {
  token: string
  request_url: string
  expires_at: string
  title: string
}

interface ReceivePageProps {
  onCreated?: (req: FileRequest) => void
}

export default function ReceivePage({ onCreated }: ReceivePageProps) {
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [expiry, setExpiry] = useState('168')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<FileRequest | null>(null)
  const [copied, setCopied] = useState(false)

  async function handleCreate() {
    if (!title.trim()) { setError("L'intitulé est requis."); return }
    setError('')
    setCreating(true)
    try {
      const res = await fetch('/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), message: message.trim() || null, expires_in_hours: parseInt(expiry) }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur')
      const data = await res.json()
      setCreated(data)
      onCreated?.(data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setCreating(false)
    }
  }

  function copy() {
    if (!created) return
    navigator.clipboard.writeText(created.request_url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  if (created) {
    return (
      <div className="card">
        <div className="share-card-header">
          <div className="share-card-status">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span className="share-card-label">LIEN DE DÉPÔT CRÉÉ</span>
          </div>
        </div>
        <div className="card-body">
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{created.title}</p>
          <p style={{ fontSize: 12, color: 'var(--subtext)', marginBottom: 16 }}>
            Partagez ce lien — les destinataires pourront déposer des fichiers sans compte.
          </p>
          <div className="share-link-row" style={{ marginBottom: 16 }}>
            <span className="share-link-url" style={{ fontSize: 13 }}>{created.request_url}</span>
            <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy}>{copied ? 'Copié' : 'Copier'}</button>
          </div>
          <button className="btn btn-outline btn-full" onClick={() => { setCreated(null); setTitle(''); setMessage(''); }}>
            Créer un autre lien
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card-body">
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Demander des fichiers</h2>
        <p style={{ fontSize: 13, color: 'var(--subtext)', marginBottom: 20 }}>
          Créez un lien de dépôt que vos destinataires pourront utiliser sans compte.
        </p>

        <div className="field">
          <label htmlFor="req-title">Intitulé <span style={{ color: 'var(--error)' }}>*</span></label>
          <input
            id="req-title"
            type="text"
            placeholder="ex. Rapport mensuel, Photos de la soirée…"
            value={title}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
        </div>

        <div className="field">
          <label htmlFor="req-message">Message <span style={{ color: 'var(--subtext)', fontWeight: 400 }}>(optionnel)</span></label>
          <textarea
            id="req-message"
            placeholder="Précisez ce que vous attendez…"
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            style={{ resize: 'vertical' }}
          />
        </div>

        <div className="chip-options" style={{ marginBottom: 20 }}>
          <div className="chip-wrap">
            <select
              className="chip chip-active"
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              style={{ cursor: 'pointer', paddingRight: 24 }}
            >
              <option value="24">⏱ Ouvert 1 jour</option>
              <option value="72">⏱ Ouvert 3 jours</option>
              <option value="168">⏱ Ouvert 7 jours</option>
              <option value="336">⏱ Ouvert 14 jours</option>
              <option value="720">⏱ Ouvert 30 jours</option>
            </select>
          </div>
        </div>

        {error && <div className="alert alert-error mt-2 mb-3">{error}</div>}

        <button className="btn btn-primary btn-full" onClick={handleCreate} disabled={creating}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {creating ? 'Création…' : 'Créer le lien de dépôt'}
        </button>
      </div>
    </div>
  )
}
