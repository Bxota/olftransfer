import { ChangeEvent, DragEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import UploadIcon from '../icons/upload-icon'
import CameraIcon from '../icons/camera-icon'
import BrandZoomIcon from '../icons/brand-zoom-icon'
import FileDescriptionIcon from '../icons/file-description-icon'
import CodeIcon from '../icons/code-icon'
import DownloadIcon from '../icons/download-icon'
import SendIcon from '../icons/send-icon'
import TrashIcon from '../icons/trash-icon'
import RefreshIcon from '../icons/refresh-icon'
import type { AnimatedIconHandle } from '../icons/types'
import { formatBytes, formatSize, formatDate, getExt, getStem, getFileCategory, FileCategory } from '../lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface TransferFile { filename: string; size_bytes: number; mime_type: string }
interface HistoryTransfer {
  token: string; name: string | null; share_url: string; created_at: string; expires_at: string
  is_expired: boolean; download_count: number; max_downloads: number | null
  has_password: boolean; files: TransferFile[]
}
interface FileProgress { pct: number; done: boolean }
interface VirusWarning { filename: string; virus: string }

// ── Upload session (localStorage) ───────────────────────────────────────────

const CHUNK_SIZE = 100 * 1024 * 1024

interface MpFile { file_id: string; filename: string; upload_id: string; total_parts: number; completed_parts: number[] }
interface MpSession { token: string; share_url: string; files: MpFile[] }

function saveSession(transfer: any, files: File[]) {
  const mpFiles: MpFile[] = transfer.uploads
    .map((u: any, i: number) => u.multipart_upload_id ? {
      file_id: u.file_id, filename: u.filename, upload_id: u.multipart_upload_id,
      total_parts: Math.ceil(files[i].size / CHUNK_SIZE), completed_parts: [],
    } : null)
    .filter(Boolean)
  if (mpFiles.length > 0)
    localStorage.setItem('mp_session', JSON.stringify({ token: transfer.token, share_url: transfer.share_url, files: mpFiles }))
}

function getSession(): MpSession | null {
  try { return JSON.parse(localStorage.getItem('mp_session') ?? 'null') } catch { return null }
}

function clearSession() { localStorage.removeItem('mp_session') }

function updateSessionProgress(fileId: string, completedParts: number[]) {
  const s = getSession(); if (!s) return
  const f = s.files.find(f => f.file_id === String(fileId))
  if (f) { f.completed_parts = completedParts; localStorage.setItem('mp_session', JSON.stringify(s)) }
}

// ── Upload helpers ───────────────────────────────────────────────────────────

function uploadFileSingle(
  file: File, url: string, index: number,
  setProgress: (fn: (prev: Record<number, FileProgress>) => Record<number, FileProgress>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    if (file.type) xhr.setRequestHeader('Content-Type', file.type)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100)
        setProgress(p => ({ ...p, [index]: { pct, done: false } }))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setProgress(p => ({ ...p, [index]: { pct: 100, done: true } }))
        resolve()
      } else {
        reject(new Error(`Erreur upload: ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error('Erreur réseau'))
    xhr.send(file)
  })
}

function uploadPart(
  chunk: Blob, url: string, partNumber: number, totalParts: number, index: number,
  setProgress: (fn: (prev: Record<number, FileProgress>) => Record<number, FileProgress>) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const overallPct = Math.round(((partNumber - 1 + e.loaded / e.total) / totalParts) * 100)
        setProgress(p => ({ ...p, [index]: { pct: overallPct, done: false } }))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else reject(new Error(`Erreur upload partie ${partNumber}: ${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error(`Erreur réseau partie ${partNumber}`))
    xhr.send(chunk)
  })
}

async function uploadFileMultipart(
  file: File, fileId: string, uploadId: string, index: number,
  setProgress: (fn: (prev: Record<number, FileProgress>) => Record<number, FileProgress>) => void,
) {
  const totalParts = Math.ceil(file.size / CHUNK_SIZE)
  const session = getSession()
  const sessionFile = session?.files?.find(f => f.file_id === String(fileId))
  let completedParts: number[] = sessionFile?.completed_parts ?? []

  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    if (completedParts.includes(partNumber)) {
      setProgress(p => ({ ...p, [index]: { pct: Math.round((partNumber / totalParts) * 100), done: false } }))
      continue
    }
    const urlRes = await fetch(`/uploads/${fileId}/part-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: uploadId, part_number: partNumber }),
    })
    if (!urlRes.ok) throw new Error(`Impossible d'obtenir l'URL de la partie ${partNumber}`)
    const { url } = await urlRes.json()
    const start = (partNumber - 1) * CHUNK_SIZE
    await uploadPart(file.slice(start, start + CHUNK_SIZE), url, partNumber, totalParts, index, setProgress)
    completedParts = [...completedParts, partNumber]
    updateSessionProgress(fileId, completedParts)
  }

  const completeRes = await fetch(`/uploads/${fileId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_id: uploadId }),
  })
  if (!completeRes.ok) throw new Error("Erreur lors de la finalisation de l'upload")
  setProgress(p => ({ ...p, [index]: { pct: 100, done: true } }))
}

function uploadFile(
  file: File, uploadInfo: any, index: number,
  setProgress: (fn: (prev: Record<number, FileProgress>) => Record<number, FileProgress>) => void,
) {
  if (uploadInfo.multipart_upload_id)
    return uploadFileMultipart(file, uploadInfo.file_id, uploadInfo.multipart_upload_id, index, setProgress)
  return uploadFileSingle(file, uploadInfo.upload_url, index, setProgress)
}

// ── Component ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuth()

  // Files
  const [files, setFiles] = useState<File[]>([])
  const [fileNames, setFileNames] = useState<string[]>([])
  const thumbUrlsRef = useRef<Record<number, string>>({})
  const [thumbVersion, setThumbVersion] = useState(0) // trigger re-render
  const uploadIconRef = useRef<AnimatedIconHandle>(null)
  const sendIconRef = useRef<AnimatedIconHandle>(null)

  // Steps
  const [step, setStep] = useState<'select' | 'uploading' | 'done'>('select')
  const [progress, setProgress] = useState<Record<number, FileProgress>>({})
  const [shareLink, setShareLink] = useState('')
  const [sendError, setSendError] = useState('')

  // Options
  const [transferName, setTransferName] = useState('')
  const [expiry, setExpiry] = useState('168')
  const [maxDownloads, setMaxDownloads] = useState('')
  const [transferPassword, setTransferPassword] = useState('')

  // Resume
  const [resumeBanner, setResumeBanner] = useState({ show: false, info: '', error: '' })
  const pendingTransferRef = useRef<any>(null)

  // History
  const [history, setHistory] = useState<HistoryTransfer[]>([])
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set())

  // Preview modal
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)

  // Virus warning
  const virusResolveRef = useRef<((ack: boolean) => void) | null>(null)
  const [virusWarning, setVirusWarning] = useState<VirusWarning | null>(null)

  // Inline delete confirm
  const [confirmToken, setConfirmToken] = useState<string | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Drag state
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => { loadHistory(); checkPendingTransfers() }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setConfirmToken(null); setBulkConfirm(false) }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // Cleanup thumb URLs on unmount
  useEffect(() => () => {
    Object.values(thumbUrlsRef.current).forEach(u => URL.revokeObjectURL(u))
  }, [])

  // Preview URL management
  useEffect(() => {
    if (!previewFile) { setPreviewUrl(null); setPreviewText(null); return }
    const cat = getFileCategory(previewFile)
    if (cat === 'text') {
      const reader = new FileReader()
      reader.onload = e => setPreviewText(e.target?.result as string)
      reader.readAsText(previewFile)
      return
    }
    const url = URL.createObjectURL(previewFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [previewFile])

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getEffectiveName(i: number, currentFiles = files, currentNames = fileNames) {
    const stem = (currentNames[i] ?? '').trim() || getStem(currentFiles[i].name)
    return stem + getExt(currentFiles[i].name)
  }

  function addFiles(newFiles: File[]) {
    setFiles(prev => {
      const next = [...prev, ...newFiles]
      newFiles.forEach((f, j) => {
        const idx = prev.length + j
        if (getFileCategory(f) === 'image') {
          thumbUrlsRef.current[idx] = URL.createObjectURL(f)
        }
      })
      setThumbVersion(v => v + 1)
      return next
    })
    setFileNames(prev => [...prev, ...newFiles.map(f => getStem(f.name))])
  }

  function removeFile(i: number) {
    if (thumbUrlsRef.current[i]) {
      URL.revokeObjectURL(thumbUrlsRef.current[i])
      delete thumbUrlsRef.current[i]
      // Shift remaining indices
      const newThumbs: Record<number, string> = {}
      Object.keys(thumbUrlsRef.current).forEach(k => {
        const n = parseInt(k)
        if (n > i) newThumbs[n - 1] = thumbUrlsRef.current[n]
        else newThumbs[n] = thumbUrlsRef.current[n]
      })
      thumbUrlsRef.current = newThumbs
      setThumbVersion(v => v + 1)
    }
    setFiles(prev => prev.filter((_, idx) => idx !== i))
    setFileNames(prev => prev.filter((_, idx) => idx !== i))
  }

  function resetTransfer() {
    Object.values(thumbUrlsRef.current).forEach(u => URL.revokeObjectURL(u))
    thumbUrlsRef.current = {}
    setThumbVersion(v => v + 1)
    setFiles([])
    setFileNames([])
    setTransferName('')
    setStep('select')
    setSendError('')
    setProgress({})
  }

  function showVirusWarning(filename: string, virus: string): Promise<boolean> {
    return new Promise(resolve => {
      virusResolveRef.current = resolve
      setVirusWarning({ filename, virus })
    })
  }

  // ── Resume ───────────────────────────────────────────────────────────────

  async function checkPendingTransfers() {
    if (getSession()) return
    try {
      const res = await fetch('/transfers/pending')
      if (!res.ok) return
      const pending = await res.json()
      if (pending.length === 0) return
      pendingTransferRef.current = pending[0]
      const names = pending[0].files.map((f: any) => f.filename).join(', ')
      setResumeBanner({ show: true, info: names, error: '' })
    } catch {}
  }

  async function resumeUpload(pending: any, selectedFiles: File[]) {
    setResumeBanner(b => ({ ...b, error: '' }))
    try {
      const resumeRes = await fetch(`/transfers/${pending.token}/resume`)
      if (!resumeRes.ok) throw new Error("Impossible de récupérer l'état du transfert.")
      const resumeData = await resumeRes.json()

      if (selectedFiles.length !== resumeData.uploads.length)
        throw new Error(`Nombre de fichiers incorrect (attendu : ${resumeData.uploads.length}).`)

      const sortedUploads = [...resumeData.uploads].sort((a: any, b: any) => a.size_bytes - b.size_bytes)
      const sortedSelected = [...selectedFiles].sort((a, b) => a.size - b.size)

      if (sortedUploads.some((u: any, i: number) => sortedSelected[i].size !== u.size_bytes))
        throw new Error('Les fichiers sélectionnés ne correspondent pas au transfert interrompu.')

      const uploadToFile = new Map(sortedUploads.map((u: any, i: number) => [u.file_id, sortedSelected[i]]))
      const orderedFiles = resumeData.uploads.map((u: any) => uploadToFile.get(u.file_id) as File)

      const session: MpSession = { token: pending.token, share_url: resumeData.share_url, files: [] }
      resumeData.uploads.forEach((u: any, i: number) => {
        if (u.multipart_upload_id) session.files.push({
          file_id: u.file_id, filename: u.filename, upload_id: u.multipart_upload_id,
          total_parts: Math.ceil(orderedFiles[i].size / CHUNK_SIZE), completed_parts: u.completed_parts,
        })
      })
      if (session.files.length > 0) localStorage.setItem('mp_session', JSON.stringify(session))

      const resumeNames = resumeData.uploads.map((u: any) => {
        const i = u.filename.lastIndexOf('.'); return i > 0 ? u.filename.slice(0, i) : u.filename
      })

      setFiles(orderedFiles)
      setFileNames(resumeNames)
      setResumeBanner(b => ({ ...b, show: false }))
      setStep('uploading')
      setProgress({})

      for (let i = 0; i < resumeData.uploads.length; i++) {
        const upload = resumeData.uploads[i]
        if (upload.multipart_upload_id) await uploadFileMultipart(orderedFiles[i], upload.file_id, upload.multipart_upload_id, i, setProgress)
        else await uploadFileSingle(orderedFiles[i], upload.upload_url, i, setProgress)
      }

      let confirmRes = await fetch(`/transfers/${pending.token}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      if (confirmRes.status === 202) {
        const warn = await confirmRes.json()
        const ack = await showVirusWarning(warn.filename, warn.virus)
        if (!ack) throw new Error('Transfert annulé.')
        confirmRes = await fetch(`/transfers/${pending.token}/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledge_risk: true }),
        })
      }
      if (!confirmRes.ok) throw new Error(await confirmRes.json().then((d: any) => d.detail).catch(() => 'Erreur'))

      clearSession()
      pendingTransferRef.current = null
      setStep('done')
      setShareLink(resumeData.share_url)
      loadHistory()
    } catch (err: any) {
      setResumeBanner(b => ({ ...b, show: true, error: err.message }))
      setStep('select')
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  async function send() {
    if (files.length === 0) return
    setSendError('')

    const currentFiles = files
    const currentNames = fileNames

    try {
      const res = await fetch('/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: currentFiles.map((f, i) => ({
            filename: getEffectiveName(i, currentFiles, currentNames),
            size_bytes: f.size,
            mime_type: f.type || null,
          })),
          name: transferName.trim() || null,
          expires_in_hours: parseInt(expiry),
          max_downloads: maxDownloads ? parseInt(maxDownloads) : null,
          password: transferPassword || null,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur')
      const transfer = await res.json()

      saveSession(transfer, currentFiles)

      setStep('uploading')
      setProgress({})

      for (let i = 0; i < currentFiles.length; i++)
        await uploadFile(currentFiles[i], transfer.uploads[i], i, setProgress)

      let confirmRes = await fetch(`/transfers/${transfer.token}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      if (confirmRes.status === 202) {
        const warn = await confirmRes.json()
        const ack = await showVirusWarning(warn.filename, warn.virus)
        if (!ack) throw new Error('Transfert annulé.')
        confirmRes = await fetch(`/transfers/${transfer.token}/confirm`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ acknowledge_risk: true }),
        })
      }
      if (!confirmRes.ok) throw new Error(await confirmRes.json().then((d: any) => d.detail).catch(() => 'Erreur'))

      clearSession()
      setStep('done')
      setShareLink(transfer.share_url)
      loadHistory()
    } catch (err: any) {
      setStep('select')
      setSendError(err.message)
    }
  }

  // ── History ───────────────────────────────────────────────────────────────

  async function loadHistory() {
    try {
      const res = await fetch('/transfers')
      if (!res.ok) throw new Error()
      setHistory(await res.json())
    } catch {}
    setSelectedTokens(new Set())
  }

  async function confirmDeleteTransfer(token: string) {
    setConfirmToken(null)
    const res = await fetch(`/transfers/${token}`, { method: 'DELETE' })
    if (res.ok) {
      setHistory(h => h.filter(t => t.token !== token))
      setSelectedTokens(s => { const n = new Set(s); n.delete(token); return n })
    } else {
      setDeleteError('Impossible de supprimer le transfert.')
      setTimeout(() => setDeleteError(''), 4000)
    }
  }

  async function confirmBulkDelete() {
    setBulkConfirm(false)
    const tokens = [...selectedTokens]
    const res = await fetch('/transfers', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens }),
    })
    if (!res.ok) {
      setDeleteError('Impossible de supprimer les transferts.')
      setTimeout(() => setDeleteError(''), 4000)
      return
    }
    const { deleted } = await res.json()
    setHistory(h => h.filter(t => !deleted.includes(t.token)))
    setSelectedTokens(new Set())
  }

  function toggleToken(token: string, checked: boolean) {
    setSelectedTokens(s => { const n = new Set(s); checked ? n.add(token) : n.delete(token); return n })
  }

  function toggleAll(checked: boolean) {
    setSelectedTokens(checked ? new Set(history.map(t => t.token)) : new Set())
  }

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login')
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const hasFiles = files.length > 0

  return (
    <>
      <header className="header">
        <Link to="/" className="logo">
          <div className="logo-icon">
            <UploadIcon size={18} strokeWidth={2.5} />
          </div>
          <span className="logo-name">OlfTransfer</span>
        </Link>
        <div className="header-actions">
          {user?.is_admin && (
            <Link to="/admin" className="btn btn-ghost btn-sm">Admin</Link>
          )}
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Déconnexion</button>
        </div>
      </header>

      <main className="page">
        <div className="page-narrow">

          {/* Resume banner */}
          {resumeBanner.show && (
            <div style={{ marginBottom: 16 }}>
              <div className="card" style={{ borderColor: '#F59E0B', background: '#FFFBEB' }}>
                <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2.5" style={{ flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontWeight: 600, fontSize: 14, margin: '0 0 2px', color: '#92400E' }}>Transfert interrompu</p>
                    <p style={{ fontSize: 12, margin: 0, color: '#B45309', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{resumeBanner.info}</p>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setResumeBanner(b => ({ ...b, show: false })); pendingTransferRef.current = null }}>Ignorer</button>
                    <button
                      className="btn btn-primary btn-sm"
                      style={{ background: '#D97706', borderColor: '#D97706' }}
                      onClick={() => {
                        const pending = pendingTransferRef.current; if (!pending) return
                        const input = document.createElement('input')
                        input.type = 'file'
                        input.multiple = pending.files.length > 1
                        input.onchange = () => { if (input.files) resumeUpload(pending, [...input.files]) }
                        input.click()
                      }}
                    >
                      Reprendre
                    </button>
                  </div>
                </div>
                {resumeBanner.error && (
                  <p style={{ color: '#EF4444', fontSize: 12, margin: 0, padding: '0 16px 12px' }}>{resumeBanner.error}</p>
                )}
              </div>
            </div>
          )}

          {/* Step: select */}
          {step === 'select' && (
            <div className="card">
              <div className="card-body">
                <div
                  className={`dropzone${dragOver ? ' drag-over' : ''}`}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={e => { e.preventDefault(); setDragOver(false); addFiles([...e.dataTransfer.files]) }}
                  onClick={() => document.getElementById('fileInput')?.click()}
                  onMouseEnter={() => uploadIconRef.current?.startAnimation()}
                  onMouseLeave={() => uploadIconRef.current?.stopAnimation()}
                >
                  <input id="fileInput" type="file" multiple style={{ display: 'none' }}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { if (e.target.files) { addFiles([...e.target.files]); e.target.value = '' } }} />
                  <div className="dropzone-icon">
                    <UploadIcon ref={uploadIconRef} size={40} strokeWidth={1.5} disableHover />
                  </div>
                  <h2>Déposer vos fichiers ici</h2>
                  <p>ou <span className="browse">parcourir</span> depuis votre appareil</p>
                </div>
              </div>

              {hasFiles && (
                <div className="card-body">
                  <p className="section-label">Fichiers sélectionnés</p>
                  <ul className="file-list">
                    {files.map((f, i) => {
                      const cat = getFileCategory(f)
                      const previewable = cat !== 'other'
                      const thumb = thumbUrlsRef.current[i]
                      return (
                        <li key={i} className="file-item">
                          {cat === 'image' && thumb ? (
                            <img className="file-thumb" src={thumb} alt="" title="Aperçu" onClick={() => setPreviewFile(f)} />
                          ) : (
                            <div
                              className={`file-type-icon${previewable ? ' previewable' : ''}`}
                              title={previewable ? 'Aperçu' : ''}
                              style={previewable ? { cursor: 'pointer' } : {}}
                              onClick={previewable ? () => setPreviewFile(f) : undefined}
                            >
                              {cat === 'image' ? <CameraIcon size={16} strokeWidth={2} /> :
                               cat === 'video' ? <BrandZoomIcon size={16} strokeWidth={2} /> :
                               cat === 'code' ? <CodeIcon size={16} strokeWidth={2} /> :
                               <FileDescriptionIcon size={16} strokeWidth={2} />}
                            </div>
                          )}
                          <div className="file-info">
                            <div className="file-name-edit">
                              <input
                                className="file-name-input"
                                type="text"
                                value={fileNames[i] ?? ''}
                                onChange={e => setFileNames(prev => { const n = [...prev]; n[i] = e.target.value; return n })}
                                title="Renommer le fichier"
                              />
                              {getExt(f.name) && <span className="file-ext">{getExt(f.name)}</span>}
                            </div>
                            <div className="file-size">{formatSize(f.size)}</div>
                          </div>
                          <button className="file-remove" title="Retirer" onClick={() => removeFile(i)}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  <button className="btn btn-outline btn-sm mt-4" onClick={() => document.getElementById('fileInput')?.click()}>
                    + Ajouter des fichiers
                  </button>
                </div>
              )}

              {hasFiles && (
                <div className="card-body">
                  <p className="section-label">Options</p>
                  <div className="options-grid">
                    <div className="field" style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor="transferName">Nom du transfert (optionnel)</label>
                      <input id="transferName" type="text" placeholder="ex : Photos vacances 2026" maxLength={100} value={transferName} onChange={e => setTransferName(e.target.value)} />
                    </div>
                    <div className="field">
                      <label htmlFor="expiry">Expiration</label>
                      <select id="expiry" value={expiry} onChange={e => setExpiry(e.target.value)}>
                        <option value="24">1 jour</option>
                        <option value="72">3 jours</option>
                        <option value="168">7 jours</option>
                        <option value="336">14 jours</option>
                        <option value="720">30 jours</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="maxDownloads">Téléchargements max</label>
                      <input id="maxDownloads" type="number" placeholder="Illimité" min="1" value={maxDownloads} onChange={e => setMaxDownloads(e.target.value)} />
                    </div>
                    <div className="field" style={{ gridColumn: '1 / -1' }}>
                      <label htmlFor="transferPassword">Mot de passe (optionnel)</label>
                      <input id="transferPassword" type="password" placeholder="Protéger par mot de passe" value={transferPassword} onChange={e => setTransferPassword(e.target.value)} />
                    </div>
                  </div>
                </div>
              )}

              {hasFiles && (
                <div className="card-body">
                  {sendError && <div className="alert alert-error mt-0 mb-3" style={{ marginBottom: 12 }}>{sendError}</div>}
                  <button
                    className="btn btn-primary btn-full"
                    onClick={send}
                    onMouseEnter={() => sendIconRef.current?.startAnimation()}
                    onMouseLeave={() => sendIconRef.current?.stopAnimation()}
                  >
                    <SendIcon ref={sendIconRef} size={16} strokeWidth={2.5} color="currentColor" disableHover />
                    Envoyer
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step: uploading */}
          {step === 'uploading' && (
            <div className="card">
              <div className="card-body">
                <p className="section-label">Envoi en cours</p>
                <ul className="file-list">
                  {files.map((f, i) => {
                    const prog = progress[i] ?? { pct: 0, done: false }
                    const cat = getFileCategory(f)
                    return (
                      <li key={i} className="file-item">
                        <div className="file-type-icon">
                          {cat === 'video' ? <BrandZoomIcon size={16} strokeWidth={2} /> :
                           cat === 'code' ? <CodeIcon size={16} strokeWidth={2} /> :
                           <FileDescriptionIcon size={16} strokeWidth={2} />}
                        </div>
                        <div className="file-info">
                          <div className="file-name">{getEffectiveName(i)}</div>
                          <div className="progress">
                            <div className="progress-bar" style={{ width: `${prog.pct}%` }} />
                          </div>
                        </div>
                        <span className={`file-status${prog.done ? ' done' : ''}`}>
                          {prog.done ? 'Envoyé' : prog.pct === 0 ? 'En attente' : `${prog.pct}%`}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>
          )}

          {/* Step: done */}
          {step === 'done' && (
            <div className="card">
              <div className="card-body text-center">
                <div style={{ width: 52, height: 52, background: '#F0FDF4', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#10B981" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Transfert prêt</h2>
                <p className="text-subtext" style={{ marginBottom: 20 }}>Partagez ce lien avec vos destinataires.</p>
                <CopyBox text={shareLink} />
                <button className="btn btn-outline btn-full mt-4" onClick={resetTransfer}>Nouveau transfert</button>
              </div>
            </div>
          )}
        </div>

        {/* History */}
        <div className="page-narrow" style={{ marginTop: 32 }}>
          <div className="card">
            <div className="card-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 16 }}>
              <p className="section-label" style={{ marginBottom: 0 }}>Mes transferts</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                {user && user.storage_quota_bytes > 0 && (
                  <QuotaBar used={user.storage_used_bytes} quota={user.storage_quota_bytes} />
                )}
              <button className="btn btn-ghost btn-sm" title="Actualiser" onClick={loadHistory}>
                <RefreshIcon size={14} strokeWidth={2.5} />
              </button>
              </div>
            </div>

            {selectedTokens.size > 0 && (
              <div id="bulkBar">
                {bulkConfirm ? (
                  <>
                    <span style={{ fontSize: 13, color: '#991B1B', fontWeight: 500 }}>
                      Supprimer {selectedTokens.size} transfert{selectedTokens.size > 1 ? 's' : ''} ?
                    </span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setBulkConfirm(false)}>Annuler</button>
                      <button className="bulk-delete-btn" onClick={confirmBulkDelete}>Confirmer</button>
                    </div>
                  </>
                ) : (
                  <>
                    <label className="bulk-select-label">
                      <input
                        type="checkbox"
                        checked={selectedTokens.size === history.length}
                        ref={el => { if (el) el.indeterminate = selectedTokens.size > 0 && selectedTokens.size < history.length }}
                        onChange={e => toggleAll(e.target.checked)}
                      />
                      <span>{selectedTokens.size} sélectionné{selectedTokens.size > 1 ? 's' : ''}</span>
                    </label>
                    <button className="bulk-delete-btn" onClick={() => setBulkConfirm(true)}>
                      <TrashIcon size={13} strokeWidth={2} dangerHover />
                      Supprimer
                    </button>
                  </>
                )}
              </div>
            )}
            {deleteError && (
              <div className="alert alert-error" style={{ margin: '0 28px 12px' }}>{deleteError}</div>
            )}

            <div>
              {history.length === 0 ? (
                <div className="card-body" style={{ paddingTop: 0, color: 'var(--subtext)', fontSize: 13, textAlign: 'center' }}>
                  Aucun transfert pour le moment.
                </div>
              ) : history.map(t => {
                const filenames = t.files.map(f => f.filename).join(', ')
                const displayName = t.name || filenames
                const totalSize = t.files.reduce((s, f) => s + f.size_bytes, 0)
                const limitReached = !!(t.max_downloads && t.download_count >= t.max_downloads)
                const canCopy = !t.is_expired && !limitReached
                const checked = selectedTokens.has(t.token)

                return (
                  <div key={t.token} className={`history-item${checked ? ' selected' : ''}`} data-token={t.token}>
                    <label className="history-chk-wrap">
                      <input type="checkbox" className="history-chk" checked={checked} onChange={e => toggleToken(t.token, e.target.checked)} />
                    </label>
                    <div className="history-main">
                      <div className="history-files">{displayName}</div>
                      {t.name && <div className="history-files" style={{ fontSize: 11, color: 'var(--subtext)', marginTop: 1 }}>{filenames}</div>}
                      <div className="history-meta">
                        <span>{formatSize(totalSize)}</span>
                        <span>Créé le {formatDate(new Date(t.created_at))}</span>
                        <span>{t.is_expired ? 'Expiré le' : 'Expire le'} {formatDate(new Date(t.expires_at))}</span>
                        {t.has_password && <span>🔒 Protégé</span>}
                      </div>
                    </div>
                    <div className="history-right">
                      {confirmToken === t.token ? (
                        <>
                          <span style={{ fontSize: 12, color: '#991B1B', fontWeight: 500, whiteSpace: 'nowrap' }}>Supprimer ?</span>
                          <button className="btn btn-ghost btn-sm" onClick={() => setConfirmToken(null)}>Non</button>
                          <button className="bulk-delete-btn" onClick={() => confirmDeleteTransfer(t.token)}>Oui</button>
                        </>
                      ) : (
                        <>
                          <span className={`history-badge history-badge--${t.is_expired || limitReached ? 'expired' : 'active'}`}>
                            {t.is_expired ? 'Expiré' : limitReached ? 'Limite atteinte' : 'Actif'}
                          </span>
                          <span className="history-dl">
                            <DownloadIcon size={12} strokeWidth={2.5} />
                            {t.max_downloads ? `${t.download_count} / ${t.max_downloads}` : t.download_count}
                          </span>
                          {canCopy && <CopyBtn url={t.share_url} />}
                          <button className="history-delete" title="Supprimer" onClick={() => setConfirmToken(t.token)}>
                            <TrashIcon size={14} strokeWidth={2} dangerHover />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </main>

      {/* Virus warning modal */}
      {virusWarning && (
        <div className="preview-modal" role="dialog" aria-modal="true">
          <div className="preview-backdrop" />
          <div className="virus-modal-container">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <div style={{ flexShrink: 0, width: 44, height: 44, background: '#FEF3C7', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2.5">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
              <div>
                <p style={{ fontWeight: 600, margin: 0, fontSize: 15 }}>Fichier potentiellement dangereux</p>
                <p style={{ color: 'var(--subtext)', fontSize: 13, margin: '4px 0 0' }}>Détecté par l'antivirus</p>
              </div>
            </div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <p style={{ fontSize: 13, margin: '0 0 6px' }}><strong>Fichier :</strong> {virusWarning.filename}</p>
              <p style={{ fontSize: 13, margin: 0 }}><strong>Signature :</strong> <code style={{ fontSize: 12, background: 'var(--card)', padding: '2px 6px', borderRadius: 4, border: '1px solid var(--border)' }}>{virusWarning.virus}</code></p>
            </div>
            <p style={{ fontSize: 13, color: 'var(--subtext)', marginBottom: 24, lineHeight: 1.5 }}>
              En tant qu'utilisateur de confiance, vous pouvez confirmer malgré la détection.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { virusResolveRef.current?.(false); setVirusWarning(null) }}>Annuler</button>
              <button className="btn btn-primary" style={{ flex: 1, background: '#D97706', borderColor: '#D97706' }} onClick={() => { virusResolveRef.current?.(true); setVirusWarning(null) }}>Je confirme quand même</button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewFile && (
        <div className="preview-modal" role="dialog" aria-modal="true" onKeyDown={e => e.key === 'Escape' && setPreviewFile(null)}>
          <div className="preview-backdrop" onClick={() => setPreviewFile(null)} />
          <div className="preview-container">
            <div className="preview-header">
              <span className="preview-filename">{previewFile.name}</span>
              <button className="preview-close" title="Fermer" onClick={() => setPreviewFile(null)}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="preview-body" style={previewText ? { background: '#1e1e1e' } : previewFile && getFileCategory(previewFile) === 'audio' ? { background: 'var(--bg)' } : {}}>
              {previewText && <pre>{previewText}</pre>}
              {previewUrl && getFileCategory(previewFile) === 'image' && <img src={previewUrl} alt={previewFile.name} />}
              {previewUrl && getFileCategory(previewFile) === 'video' && <video src={previewUrl} controls onPause={undefined} />}
              {previewUrl && getFileCategory(previewFile) === 'audio' && <audio src={previewUrl} controls />}
              {previewUrl && getFileCategory(previewFile) === 'pdf' && <iframe src={previewUrl} title={previewFile.name} style={{ background: 'white' }} />}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── Small components ─────────────────────────────────────────────────────────

function QuotaBar({ used, quota }: { used: number; quota: number }) {
  const pct = Math.min(100, Math.round(used / quota * 100))
  const color = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : 'var(--success)'
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 11, color: 'var(--subtext)', marginBottom: 3 }}>{formatBytes(used)} / {formatBytes(quota)}</div>
      <div style={{ width: 110, height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 2 }} />
      </div>
    </div>
  )
}

function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="share-box">
      <span className="share-link">{text}</span>
      <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy}>{copied ? 'Copié' : 'Copier'}</button>
    </div>
  )
}

function CopyBtn({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button className={`history-copy${copied ? ' copied' : ''}`} onClick={copy}>{copied ? 'Copié' : 'Copier'}</button>
  )
}
