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
}

type PageState = 'loading' | 'password' | 'error' | 'ready'

export default function TransferPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<PageState>('loading')
  const [transfer, setTransfer] = useState<TransferData | null>(null)
  const [errorTitle, setErrorTitle] = useState('Transfert introuvable')
  const [errorMsg, setErrorMsg] = useState("Ce lien n'existe pas ou a expiré.")
  const [passwordInput, setPasswordInput] = useState('')
  const [pwError, setPwError] = useState('')
  const passwordRef = useRef<string | null>(null)

  useEffect(() => { loadTransfer() }, [token])

  async function loadTransfer() {
    try {
      const res = await fetch(`/transfers/${token}`)
      if (res.status === 404 || res.status === 410) {
        const data = await res.json()
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
    if (res.status === 401) {
      setState('password')
      return null
    }
    if (res.status === 403) {
      setPwError('Mot de passe incorrect.')
      setState('password')
      return null
    }
    if (!res.ok) {
      const data = await res.json()
      setErrorTitle('Erreur')
      setErrorMsg(data.detail)
      setState('error')
      return null
    }
    return (await res.json()).files
  }

  function triggerDownload(url: string, filename: string) {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
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
    if (res.status === 403) {
      setPwError('Mot de passe incorrect.')
      return
    }
    if (!res.ok) {
      const data = await res.json()
      setErrorTitle('Erreur')
      setErrorMsg(data.detail)
      setState('error')
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
              <div className="card-body">
                <h2 style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>Transfert protégé</h2>
                <p className="text-subtext" style={{ marginBottom: 20 }}>
                  Ce transfert est protégé par un mot de passe.
                </p>
                <div className="field">
                  <label htmlFor="passwordInput">Mot de passe</label>
                  <input
                    id="passwordInput"
                    type="password"
                    placeholder="••••••••"
                    autoFocus
                    value={passwordInput}
                    onChange={e => setPasswordInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleUnlock()}
                  />
                </div>
                {pwError && <div className="alert alert-error mt-3">{pwError}</div>}
                <button className="btn btn-primary btn-full mt-4" onClick={handleUnlock}>
                  Déverrouiller
                </button>
              </div>
            </div>
          )}

          {state === 'error' && (
            <div className="card">
              <div className="card-body text-center">
                <div style={{ width: 52, height: 52, background: '#FEF2F2', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>{errorTitle}</h2>
                <p className="text-subtext">{errorMsg}</p>
              </div>
            </div>
          )}

          {state === 'ready' && transfer && (
            <>
              <div className="transfer-header">
                <h1 className="transfer-title">
                  {transfer.name || `${transfer.files.length} fichier${transfer.files.length > 1 ? 's' : ''}`}
                </h1>
                {transfer.name && (
                  <p style={{ margin: '2px 0 0', fontSize: 13, color: 'var(--subtext)' }}>
                    {transfer.files.length} fichier{transfer.files.length > 1 ? 's' : ''}
                  </p>
                )}
                <p className="transfer-meta">
                  <span>{transfer.files.map(f => formatSize(f.size_bytes)).join(', ')}</span>
                  <span>Expire le {formatDateLong(transfer.expires_at)}</span>
                  {transfer.max_downloads && (
                    <span>
                      {transfer.download_count}/{transfer.max_downloads} téléchargements
                    </span>
                  )}
                </p>
              </div>
              <div className="card">
                <div className="card-body">
                  <p className="section-label">Fichiers</p>
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
                          <div className="file-size">{formatSize(f.size_bytes)}</div>
                        </div>
                        <button className="btn btn-outline btn-sm download-btn" onClick={() => downloadFile(i)}>
                          Télécharger
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="card-body">
                  <button className="btn btn-primary btn-full" onClick={downloadAll}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Tout télécharger
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  )
}
