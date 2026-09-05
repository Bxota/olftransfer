import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatSize } from '../lib/utils'
import { MultipartEndpoints, uploadMultipart, uploadSingle } from '../lib/upload'
import { QrPopover } from '../components/QrPopover'

interface RequestInfo {
  title: string
  message: string | null
  expires_at: string
  requester_username: string
  request_url: string
}

interface UploadedFile {
  name: string
  size: number
  done: boolean
  pct: number
}

type PageState = 'loading' | 'error' | 'form' | 'uploading' | 'done'

export default function RequestDropPage() {
  const { token } = useParams<{ token: string }>()
  const [state, setState] = useState<PageState>('loading')
  const [info, setInfo] = useState<RequestInfo | null>(null)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [uploaded, setUploaded] = useState<UploadedFile[]>([])
  const [shareLink, setShareLink] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const dragCounter = useRef(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch(`/requests/${token}`)
      .then(async r => {
        if (!r.ok) { setError("Ce lien de dépôt est introuvable ou a expiré."); setState('error'); return }
        const data = await r.json()
        setInfo(data)
        setState('form')
      })
      .catch(() => { setError('Impossible de charger la demande.'); setState('error') })
  }, [token])

  function addFiles(newFiles: File[]) {
    setFiles(prev => [...prev, ...newFiles])
  }

  function removeFile(i: number) {
    setFiles(prev => prev.filter((_, idx) => idx !== i))
  }

  function onDragEnter(e: DragEvent) { e.preventDefault(); dragCounter.current++; setDragOver(true) }
  function onDragLeave() { dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setDragOver(false) } }
  function onDragOver(e: DragEvent) { e.preventDefault() }
  function onDrop(e: DragEvent) {
    e.preventDefault(); dragCounter.current = 0; setDragOver(false)
    if (e.dataTransfer?.files) addFiles([...e.dataTransfer.files])
  }

  async function handleSend() {
    if (files.length === 0) return
    setState('uploading')

    try {
      const res = await fetch(`/requests/${token}/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: files.map(f => ({ filename: f.name, size_bytes: f.size, mime_type: f.type || null })),
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur')
      const transfer = await res.json()
      setShareLink(transfer.share_url)

      const uploadedState: UploadedFile[] = files.map(f => ({ name: f.name, size: f.size, done: false, pct: 0 }))
      setUploaded([...uploadedState])

      const base = `/requests/${token}/transfers/${transfer.token}/uploads`
      const endpoints: MultipartEndpoints = {
        async listParts(fileId, uploadId) {
          const r = await fetch(`${base}/${fileId}/parts?upload_id=${encodeURIComponent(uploadId)}`)
          if (!r.ok) return []
          return (await r.json()).parts
        },
        async partUrls(fileId, uploadId, partNumbers) {
          const r = await fetch(`${base}/${fileId}/part-urls`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upload_id: uploadId, part_numbers: partNumbers }),
          })
          if (!r.ok) throw new Error("Impossible d'obtenir les URLs des parties")
          return Object.fromEntries((await r.json()).urls.map((u: any) => [u.part_number, u.url]))
        },
        async complete(fileId, uploadId) {
          const r = await fetch(`${base}/${fileId}/complete`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ upload_id: uploadId }),
          })
          if (!r.ok) throw new Error("Erreur lors de la finalisation de l'upload")
        },
      }

      const onProgress = (i: number, cap: number) => (loaded: number, total: number) => {
        uploadedState[i].pct = Math.min(cap, Math.round((loaded / total) * 100))
        setUploaded([...uploadedState])
      }

      for (let i = 0; i < files.length; i++) {
        const uploadInfo = transfer.uploads[i]
        if (uploadInfo.multipart_upload_id) {
          await uploadMultipart(files[i], uploadInfo.file_id, uploadInfo.multipart_upload_id, endpoints, { onProgress: onProgress(i, 99) })
        } else {
          await uploadSingle(files[i], uploadInfo.upload_url, onProgress(i, 100))
        }
        uploadedState[i].done = true
        uploadedState[i].pct = 100
        setUploaded([...uploadedState])
      }

      await fetch(`/requests/${token}/transfers/${transfer.token}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })

      setState('done')
    } catch (e: any) {
      setError(e.message)
      setState('form')
    }
  }

  return (
    <>
      <header className="header public-header">
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

      <main className="page public-surface request-drop-page">
        <div className="page-narrow">
          {state === 'loading' && <div className="text-center text-subtext">Chargement…</div>}

          {state === 'error' && (
            <div className="card">
              <div className="card-body text-center">
                <div style={{ width: 42, height: 42, margin: '0 auto 12px', color: 'var(--subtext)' }}><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
                <h2 style={{ fontSize: 16, fontWeight: 700 }}>Lien introuvable</h2>
                <p className="text-subtext" style={{ fontSize: 13 }}>{error}</p>
              </div>
            </div>
          )}

          {(state === 'form' || state === 'uploading') && info && (
            <div className="card">
              <div className="card-body">
                <div className="transfer-sender" style={{ justifyContent: 'flex-start', marginBottom: 12 }}>
                  <div className="sender-avatar">{info.requester_username[0].toUpperCase()}</div>
                  <span style={{ fontSize: 13 }}><strong>{info.requester_username}</strong> vous demande des fichiers</span>
                </div>

                <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.3px', marginBottom: 8 }}>{info.title}</h1>

                {info.message && (
                  <div style={{ background: 'var(--primary-light)', border: '1px solid #c7ece6', borderRadius: 10, padding: '12px 14px', marginBottom: 20, fontSize: 13.5, color: '#0f4c43', lineHeight: 1.5 }}>
                    {info.message}
                  </div>
                )}

                <div
                  className={`dropzone${dragOver ? ' drag-over' : ''}`}
                  style={{ marginBottom: files.length > 0 ? 16 : 0 }}
                  onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}
                  onClick={() => state === 'form' && document.getElementById('req-file-input')?.click()}
                >
                  <input id="req-file-input" type="file" multiple style={{ display: 'none' }}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) { addFiles([...e.target.files]); e.target.value = '' } }} />
                  <div className="dropzone-icon">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <h2>Déposer vos fichiers ici</h2>
                  <p>ou <span className="browse">parcourir</span> depuis votre appareil</p>
                </div>

                {files.length > 0 && (
                  <ul className="file-list" style={{ marginBottom: 16 }}>
                    {files.map((f, i) => {
                      const prog = uploaded[i]
                      return (
                        <li key={i} className="file-item">
                          <div className="file-type-icon">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                            </svg>
                          </div>
                          <div className="file-info">
                            <div className="file-name">{f.name}</div>
                            {state === 'uploading' && prog && (
                              <div className="progress">
                                <div className="progress-bar" style={{ width: `${prog.pct}%` }} />
                              </div>
                            )}
                          </div>
                          <span className={`file-status${prog?.done ? ' done' : ''}`} style={{ fontFamily: prog?.done ? undefined : "'Geist Mono', monospace" }}>
                            {prog?.done ? 'Envoyé' : state === 'uploading' ? `${prog?.pct ?? 0}%` : formatSize(f.size)}
                          </span>
                          {state === 'form' && (
                            <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--subtext)', padding: 4 }}>✕</button>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}

                {error && <div className="alert alert-error mb-3">{error}</div>}

                {state === 'form' && (
                  <button className="btn btn-primary btn-full" disabled={files.length === 0} onClick={handleSend}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    Envoyer à {info.requester_username}
                  </button>
                )}

                {state === 'uploading' && (
                  <button className="btn btn-primary btn-full" disabled>
                    Envoi en cours…
                  </button>
                )}

                <p className="privacy-note" style={{ fontSize: 11.5, color: 'var(--subtext)', textAlign: 'center', marginTop: 14 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  Vos fichiers ne sont visibles que par {info.requester_username}
                </p>
              </div>
            </div>
          )}

          {state === 'done' && info && (
            <div className="card">
              <div className="card-body text-center">
                <div style={{ width: 52, height: 52, borderRadius: '50%', background: '#F0FDF4', border: '2px solid #86efac', color: '#15803d', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}><svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg></div>
                <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Fichiers envoyés !</h2>
                <p style={{ fontSize: 13, color: 'var(--subtext)', marginBottom: 20 }}>
                  {info.requester_username} a été notifié et peut maintenant accéder à vos fichiers.
                </p>

                {shareLink && (
                  <div style={{ marginBottom: 20 }}>
                    <p style={{ fontSize: 12, color: 'var(--subtext)', marginBottom: 8 }}>Lien du transfert :</p>
                    <div className="share-link-row" style={{ justifyContent: 'center', gap: 8 }}>
                      <span className="share-link-url" style={{ fontSize: 12.5 }}>{shareLink}</span>
                      <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={() => { navigator.clipboard.writeText(shareLink); setCopied(true); setTimeout(() => setCopied(false), 2000) }}>
                        {copied ? 'Copié' : 'Copier'}
                      </button>
                      <QrPopover url={shareLink} />
                    </div>
                  </div>
                )}

                <ul className="file-list" style={{ marginBottom: 20, textAlign: 'left' }}>
                  {uploaded.map((f, i) => (
                    <li key={i} className="file-item">
                      <div className="file-type-icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
                        </svg>
                      </div>
                      <div className="file-info"><div className="file-name">{f.name}</div></div>
                      <span className="file-status done">Envoyé</span>
                    </li>
                  ))}
                </ul>

                <p className="privacy-note" style={{ fontSize: 11.5, color: 'var(--subtext)' }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                  Vos fichiers ne sont visibles que par {info.requester_username}
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
