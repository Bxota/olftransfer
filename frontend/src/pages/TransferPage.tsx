import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatSize, formatDateLong } from '../lib/utils'

interface TransferFile {
  filename: string
  size_bytes: number
}

interface TransferData {
  token: string
  name: string | null
  expires_at: string
  download_count: number
  max_downloads: number | null
  has_password: boolean
  files: TransferFile[]
  sender_username?: string
}

type PageState = 'loading' | 'password' | 'error' | 'ready'

function getExpiryDays(expiresAt: string): number {
  const diff = new Date(expiresAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
}

export default function TransferPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<PageState>('loading')
  const [transfer, setTransfer] = useState<TransferData | null>(null)
  const [errorTitle, setErrorTitle] = useState('Transfert introuvable')
  const [errorMsg, setErrorMsg] = useState("Ce lien n'existe pas ou a expiré.")
  const [isExpired, setIsExpired] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [pwError, setPwError] = useState('')
  const passwordRef = useRef<string | null>(null)

  useEffect(() => { loadTransfer() }, [token])

  async function loadTransfer() {
    try {
      const res = await fetch(`/transfers/${token}`)
      if (res.status === 404 || res.status === 410) {
        const data = await res.json()
        setIsExpired(res.status === 410)
        setErrorTitle(res.status === 410 ? 'Transfert expiré' : 'Transfert introuvable')
        setErrorMsg(data.detail)
        setState('error')
        return
      }
      if (!res.ok) throw new Error()
      const data = await res.json()
      setTransfer(data)
      setState(data.has_password ? 'password' : 'ready')
    } catch {
      setErrorTitle('Erreur')
      setErrorMsg('Impossible de charger ce transfert.')
      setState('error')
    }
  }

  async function getDownloadUrls(): Promise<{ filename: string; download_url: string }[] | null> {
    const params = passwordRef.current ? `?password=${encodeURIComponent(passwordRef.current)}` : ''
    const res = await fetch(`/transfers/${token}/download${params}`)
    if (res.status === 401) { setState('password'); return null }
    if (res.status === 403) { setPwError('Mot de passe incorrect.'); setState('password'); return null }
    if (!res.ok) {
      const data = await res.json()
      setErrorTitle('Erreur'); setErrorMsg(data.detail); setState('error')
      return null
    }
    return (await res.json()).files
  }

  function triggerDownload(url: string, filename: string) {
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.target = '_blank'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  async function downloadFile(index: number) {
    const files = await getDownloadUrls()
    if (!files) return
    triggerDownload(files[index].download_url, files[index].filename)
  }

  async function downloadAll() {
    if (transfer && transfer.files.length > 1) {
      const params = passwordRef.current ? `?password=${encodeURIComponent(passwordRef.current)}` : ''
      triggerDownload(`/transfers/${token}/download-zip${params}`, `${token}.zip`)
      return
    }
    const files = await getDownloadUrls()
    if (!files) return
    for (const f of files) {
      triggerDownload(f.download_url, f.filename)
      await new Promise(r => setTimeout(r, 200))
    }
  }

  async function handleUnlock() {
    setPwError('')
    const res = await fetch(`/transfers/${token}?password=${encodeURIComponent(passwordInput)}`)
    if (res.status === 403) { setPwError('Mot de passe incorrect.'); return }
    if (!res.ok) {
      const data = await res.json()
      setErrorTitle('Erreur'); setErrorMsg(data.detail); setState('error')
      return
    }
    passwordRef.current = passwordInput
    setTransfer(await res.json())
    setState('ready')
  }

  return (
    <>
      <header className="header">
        <Link to="/" className="logo">
          <div className="logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </div>
          <span className="logo-name">OlfTransfer</span>
        </Link>
      </header>

      <main className="page">
        <div className="page-narrow">
          {state === 'loading' && (
            <div className="text-center text-subtext">Chargement…</div>
          )}

          {state === 'password' && (
            <div className="card">
              <div className="card-body" style={{ textAlign: 'center', paddingBottom: 0 }}>
                <div style={{ width: 52, height: 52, background: 'var(--primary-light)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Transfert protégé</h2>
                <p className="text-subtext" style={{ marginBottom: 0 }}>Ce transfert est protégé par un mot de passe.</p>
              </div>
              <div className="card-body">
                <div className="field">
                  <label htmlFor="passwordInput">Mot de passe</label>
                  <input id="passwordInput" type="password" placeholder="••••••••" autoFocus
                    value={passwordInput} onChange={e => setPasswordInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleUnlock()} />
                </div>
                {pwError && <div className="alert alert-error mt-3">{pwError}</div>}
                <button className="btn btn-primary btn-full mt-4" onClick={handleUnlock}>Déverrouiller</button>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div className="card">
              <div className="card-body text-center">
                <div style={{ width: 52, height: 52, background: isExpired ? '#FFFBEB' : '#FEF2F2', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  {isExpired ? (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#c9542f" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                    </svg>
                  ) : (
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2.5">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  )}
                </div>
                <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{errorTitle}</h2>
                <p className="text-subtext" style={{ marginBottom: isExpired ? 20 : 0 }}>{errorMsg}</p>
                {isExpired && (
                  <a href="mailto:?subject=Nouveau lien OlfTransfer&body=Bonjour, pourriez-vous m'envoyer un nouveau lien ?" className="btn btn-outline" style={{ display: 'inline-flex' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                      <polyline points="22,6 12,13 2,6" />
                    </svg>
                    Demander un nouveau lien
                  </a>
                )}
              </div>
            </div>
          )}

          {state === 'ready' && transfer && (() => {
            const totalSize = transfer.files.reduce((s, f) => s + f.size_bytes, 0)
            const expiryDays = getExpiryDays(transfer.expires_at)
            return (
              <>
                <div className="transfer-header">
                  {transfer.sender_username && (
                    <div className="transfer-sender">
                      <div className="sender-avatar">{transfer.sender_username[0].toUpperCase()}</div>
                      <span><strong>{transfer.sender_username}</strong> vous a envoyé des fichiers</span>
                    </div>
                  )}
                  <h1 className="transfer-title">
                    {transfer.name || `${transfer.files.length} fichier${transfer.files.length > 1 ? 's' : ''}`}
                  </h1>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                    <span className="transfer-meta" style={{ margin: 0 }}>
                      {transfer.files.length} fichier{transfer.files.length > 1 ? 's' : ''} · {formatSize(totalSize)}
                    </span>
                    <span className="expiry-chip">
                      ⏱ Expire {expiryDays === 0 ? "aujourd'hui" : `dans ${expiryDays} jour${expiryDays > 1 ? 's' : ''}`}
                    </span>
                    {transfer.max_downloads && (
                      <span style={{ fontSize: 12, color: 'var(--subtext)' }}>
                        {transfer.download_count}/{transfer.max_downloads} téléchargements
                      </span>
                    )}
                  </div>
                </div>

                <button
                  className="btn btn-primary btn-full"
                  style={{ marginBottom: 16, borderRadius: 11, boxShadow: '0 4px 14px rgba(13,148,136,.25)', fontSize: 15, padding: '14px 22px' }}
                  onClick={downloadAll}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Tout télécharger · {formatSize(totalSize)}
                </button>

                <div className="card">
                  <div className="card-body">
                    <ul className="file-list">
                      {transfer.files.map((f, i) => (
                        <li key={i} className="download-item">
                          <div className="file-type-icon">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                          </div>
                          <div className="file-info">
                            <div className="file-name">{f.filename}</div>
                          </div>
                          <button className="download-icon-btn" title={`Télécharger ${f.filename}`} onClick={() => downloadFile(i)}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                              <polyline points="7 10 12 15 17 10" />
                              <line x1="12" y1="15" x2="12" y2="3" />
                            </svg>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                      {transfer.files.map((f, i) => (
                        <span key={i} style={{ fontSize: 12, color: 'var(--subtext)', fontFamily: "'Geist Mono', monospace" }}>
                          {f.filename} — {formatSize(f.size_bytes)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="card-body" style={{ paddingTop: 0 }}>
                    <div className="trust-line">
                      <span className="trust-item trust-item--verified">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                        Analysé (antivirus)
                      </span>
                      <span className="trust-item">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                        Lien chiffré
                      </span>
                      <span className="trust-item">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                        Aucun compte requis
                      </span>
                    </div>
                  </div>
                </div>
              </>
            )
          })()}
        </div>
      </main>
    </>
  )
}
