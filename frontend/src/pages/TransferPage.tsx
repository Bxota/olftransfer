import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatSize, formatDateLong } from '../lib/utils'
import { QrPopover } from '../components/QrPopover'
import { PreviewModal, PreviewKind } from '../components/PreviewModal'

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
  zip_download_available: boolean
}

type PageState = 'loading' | 'password' | 'error' | 'ready'

function getExpiryDays(expiresAt: string): number {
  const diff = new Date(expiresAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)))
}

function getFileExt(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i > 0 ? filename.slice(i + 1).toUpperCase() : '—'
}

function isImageFile(filename: string): boolean {
  return /\.(jpe?g|png|gif|webp|svg|avif|heic)$/i.test(filename)
}

function isVideoFile(filename: string): boolean {
  return /\.(mp4|webm|mov|mkv|avi)$/i.test(filename)
}

function isAudioFile(filename: string): boolean {
  return /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(filename)
}

function isPdfFile(filename: string): boolean {
  return /\.pdf$/i.test(filename)
}

function isPreviewable(filename: string): boolean {
  return isImageFile(filename) || isVideoFile(filename) || isAudioFile(filename) || isPdfFile(filename)
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

  // Preview modal
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewFilename, setPreviewFilename] = useState<string | null>(null)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState<number | null>(null)

  // Download in-flight (anti spam-click)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<number | null>(null)

  useEffect(() => { loadTransfer() }, [token])

  function closePreview() { setPreviewUrl(null); setPreviewFilename(null); setPreviewIndex(null) }

  async function loadTransfer() {
    try {
      const res = await fetch(`/transfers/${token}`)
      if (res.status === 404 || res.status === 410) {
        const data = await res.json()
        setIsExpired(res.status === 410)
        setErrorTitle(res.status === 410 ? 'Ce lien a expiré' : 'Transfert introuvable')
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

  async function getDownloadUrls(inline = false): Promise<{ filename: string; download_url: string }[] | null> {
    const p = new URLSearchParams()
    if (passwordRef.current) p.set('password', passwordRef.current)
    if (inline) p.set('inline', 'true')
    const params = p.toString() ? `?${p.toString()}` : ''
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
    if (downloadingFile !== null) return
    setDownloadingFile(index)
    try {
      const files = await getDownloadUrls()
      if (!files) return
      triggerDownload(files[index].download_url, files[index].filename)
    } finally {
      setDownloadingFile(null)
    }
  }

  async function downloadAll() {
    if (downloadingAll) return
    setDownloadingAll(true)
    try {
      if (transfer && transfer.files.length > 1 && transfer.zip_download_available) {
        const params = passwordRef.current ? `?password=${encodeURIComponent(passwordRef.current)}` : ''
        triggerDownload(`/transfers/${token}/download-zip${params}`, `${token}.zip`)
        // Le zip se construit côté serveur : on garde le bouton désactivé quelques secondes
        await new Promise(r => setTimeout(r, 5000))
        return
      }
      const files = await getDownloadUrls()
      if (!files) return
      for (const f of files) {
        triggerDownload(f.download_url, f.filename)
        await new Promise(r => setTimeout(r, 200))
      }
    } finally {
      setDownloadingAll(false)
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

  async function openPreview(index: number, filename: string) {
    if (previewLoading !== null) return
    setPreviewLoading(index)
    const files = await getDownloadUrls(true)
    setPreviewLoading(null)
    if (!files) return
    setPreviewFilename(filename)
    setPreviewIndex(index)
    setPreviewUrl(files[index].download_url)
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
                <div style={{ width: 46, height: 46, borderRadius: '50%', border: '2px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 13px', fontSize: 20 }}>🔒</div>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 5 }}>Transfert protégé</h2>
                <p className="text-subtext" style={{ marginBottom: 0, fontSize: 12.5 }}>Saisissez le mot de passe partagé par l'expéditeur.</p>
              </div>
              <div className="card-body">
                <div className="field">
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
                <div style={{ width: 46, height: 46, borderRadius: '50%', border: `2px solid ${isExpired ? '#c9542f' : '#EF4444'}`, color: isExpired ? '#c9542f' : '#EF4444', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 13px', fontSize: 22 }}>
                  {isExpired ? '⌛' : '!'}
                </div>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 5 }}>{errorTitle}</h2>
                <p className="text-subtext" style={{ fontSize: 12.5, lineHeight: 1.45, marginBottom: isExpired ? 18 : 0 }}>{errorMsg}</p>
                {isExpired && (
                  <a href="mailto:?subject=Nouveau lien OlfTransfer&body=Bonjour, pourriez-vous m'envoyer un nouveau lien ?" className="btn btn-outline btn-full" style={{ display: 'flex' }}>
                    ✉ Demander un nouveau lien
                  </a>
                )}
              </div>
            </div>
          )}

          {state === 'ready' && transfer && (() => {
            const totalSize = transfer.files.reduce((s, f) => s + f.size_bytes, 0)
            const expiryDays = getExpiryDays(transfer.expires_at)

            return (
              <div className="card">
                <div className="card-body">
                  {transfer.sender_username && (
                    <div className="transfer-sender" style={{ justifyContent: 'flex-start', marginBottom: 8 }}>
                      <div className="sender-avatar">{transfer.sender_username[0].toUpperCase()}</div>
                      <span style={{ fontSize: 12.5 }}><strong>{transfer.sender_username}</strong> vous a envoyé des fichiers</span>
                    </div>
                  )}

                  <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.4px', marginBottom: 8 }}>
                    {transfer.name || `${transfer.files.length} fichier${transfer.files.length > 1 ? 's' : ''}`}
                  </h1>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                    <span style={{ fontSize: 13, color: 'var(--subtext)' }}>
                      {transfer.files.length} fichier{transfer.files.length > 1 ? 's' : ''} · {formatSize(totalSize)}
                    </span>
                    <span className="expiry-chip">
                      ⏱ Expire {expiryDays === 0 ? "aujourd'hui" : `dans ${expiryDays} jour${expiryDays > 1 ? 's' : ''}`}
                    </span>
                    {transfer.max_downloads && (
                      <span style={{ fontSize: 12, color: 'var(--subtext)' }}>
                        {transfer.download_count}/{transfer.max_downloads} téléch.
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginBottom: 22, alignItems: 'stretch' }}>
                  <button
                    className="btn btn-primary"
                    style={{ flex: 1, borderRadius: 11, boxShadow: '0 4px 14px rgba(13,148,136,.25)', fontSize: 16, fontWeight: 700, padding: '16px 22px' }}
                    onClick={downloadAll}
                    disabled={downloadingAll}
                  >
                    {downloadingAll ? (
                      <>
                        <span className="btn-spinner" aria-hidden="true" />
                        Préparation du téléchargement…
                      </>
                    ) : (
                      <>
                        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="7 10 12 15 17 10" />
                          <line x1="12" y1="15" x2="12" y2="3" />
                        </svg>
                        Tout télécharger · {formatSize(totalSize)}
                      </>
                    )}
                  </button>
                  <QrPopover url={window.location.href} style={{ height: 'auto', width: 56, borderRadius: 11 }} />
                  </div>

                  <p className="section-label">Fichiers</p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
                    {transfer.files.map((f, i) => {
                      const ext = getFileExt(f.filename)
                      const isImg = isImageFile(f.filename)
                      const canPreview = isPreviewable(f.filename)
                      const loading = previewLoading === i

                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '11px 13px', border: '1.5px solid var(--border)', borderRadius: 11 }}>
                          <div style={{
                            width: 48, height: 48, borderRadius: 8, flexShrink: 0,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            background: isImg
                              ? 'repeating-linear-gradient(45deg,#e3e2db,#e3e2db 6px,#dad9d1 6px,#dad9d1 12px)'
                              : 'var(--primary-light)',
                            border: isImg ? 'none' : '1.5px solid #c7ece6',
                            fontFamily: "'Geist Mono', monospace", fontSize: 9, color: isImg ? '#8a897e' : 'var(--primary)', fontWeight: 600,
                          }}>
                            {isImg ? 'IMG' : ext}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.filename}</div>
                            <div style={{ fontSize: 12, color: 'var(--subtext)', marginTop: 2 }}>{formatSize(f.size_bytes)}</div>
                          </div>
                          <button
                            style={{
                              padding: '7px 12px', border: '1.5px solid var(--border)', borderRadius: 8,
                              fontSize: 12, background: 'white', cursor: canPreview ? 'pointer' : 'default',
                              color: canPreview ? 'var(--subtext)' : '#b5b4ab',
                              flexShrink: 0, transition: 'all .15s',
                              opacity: canPreview ? 1 : 0.45,
                            }}
                            disabled={!canPreview || loading}
                            onClick={() => canPreview && openPreview(i, f.filename)}
                            title={canPreview ? 'Aperçu' : 'Aperçu non disponible'}
                          >
                            {loading ? '…' : 'Aperçu'}
                          </button>
                          <button className="download-icon-btn" title={`Télécharger ${f.filename}`} disabled={downloadingFile !== null} onClick={() => downloadFile(i)}>
                            {downloadingFile === i ? (
                              <span className="btn-spinner btn-spinner--dark" aria-hidden="true" />
                            ) : (
                              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                <polyline points="7 10 12 15 17 10" />
                                <line x1="12" y1="15" x2="12" y2="3" />
                              </svg>
                            )}
                          </button>
                        </div>
                      )
                    })}
                  </div>

                  <div className="trust-line">
                    <span className="trust-item trust-item--verified">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12" /></svg>
                      Fichiers vérifiés
                    </span>
                    <span className="trust-item">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
                      Connexion chiffrée
                    </span>
                    <span className="trust-item">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                      Aucun compte requis
                    </span>
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      </main>

      {/* Preview modal */}
      {previewUrl && previewFilename && (() => {
        const kind: PreviewKind = isImageFile(previewFilename) ? 'image'
          : isVideoFile(previewFilename) ? 'video'
          : isAudioFile(previewFilename) ? 'audio'
          : 'pdf'
        return (
          <PreviewModal
            filename={previewFilename}
            kind={kind}
            src={previewUrl}
            onClose={closePreview}
            onDownload={previewIndex !== null ? () => downloadFile(previewIndex) : undefined}
          />
        )
      })()}
    </>
  )
}
