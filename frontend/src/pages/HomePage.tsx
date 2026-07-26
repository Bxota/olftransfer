import { ChangeEvent, DragEvent, MouseEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../App'
import { QrPopover } from '../components/QrPopover'
import ReceivePage from './ReceivePage'
import UploadIcon from '../icons/upload-icon'
import CameraIcon from '../icons/camera-icon'
import BrandZoomIcon from '../icons/brand-zoom-icon'
import FileDescriptionIcon from '../icons/file-description-icon'
import CodeIcon from '../icons/code-icon'
import CopyIcon from '../icons/copy-icon'
import DownloadIcon from '../icons/download-icon'
import TrashIcon from '../icons/trash-icon'
import RefreshIcon from '../icons/refresh-icon'
import type { AnimatedIconHandle } from '../icons/types'
import { formatBytes, formatSize, formatDate, getExt, getStem, getFileCategory, runWithConcurrency, FileCategory } from '../lib/utils'
import { CHUNK_SIZE, UPLOAD_CONCURRENCY, MultipartEndpoints, uploadMultipart, uploadSingle } from '../lib/upload'
import { PreviewModal, PreviewKind } from '../components/PreviewModal'

// ── Types ────────────────────────────────────────────────────────────────────

interface TransferFile { filename: string; size_bytes: number; mime_type: string }
interface HistoryTransfer {
  token: string; name: string | null; share_url: string; created_at: string; expires_at: string
  is_expired: boolean; is_archived: boolean; is_restoring: boolean
  download_count: number; max_downloads: number | null
  has_password: boolean; files: TransferFile[]
  view_mode: 'auto' | 'gallery' | 'list'
}
interface FileProgress { pct: number; done: boolean }

// ── Upload session (localStorage) ───────────────────────────────────────────

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

// Ajoute des fichiers multipart à la session de reprise d'un transfert existant.
function appendSession(token: string, uploads: any[], files: File[]) {
  const s = getSession()
  if (!s || s.token !== token) return
  uploads.forEach((u, j) => {
    if (u.multipart_upload_id) s.files.push({
      file_id: u.file_id, filename: u.filename, upload_id: u.multipart_upload_id,
      total_parts: Math.ceil(files[j].size / CHUNK_SIZE), completed_parts: [],
    })
  })
  localStorage.setItem('mp_session', JSON.stringify(s))
}

// ── Upload helpers ───────────────────────────────────────────────────────────

type SetProgress = (fn: (prev: Record<number, FileProgress>) => Record<number, FileProgress>) => void

// Endpoints d'upload authentifiés (utilisateur connecté).
const authedEndpoints: MultipartEndpoints = {
  async listParts(fileId, uploadId) {
    const r = await fetch(`/uploads/${fileId}/parts?upload_id=${encodeURIComponent(uploadId)}`)
    if (!r.ok) return []
    return (await r.json()).parts
  },
  async partUrls(fileId, uploadId, partNumbers) {
    const r = await fetch(`/uploads/${fileId}/part-urls`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: uploadId, part_numbers: partNumbers }),
    })
    if (!r.ok) throw new Error("Impossible d'obtenir les URLs des parties")
    const data = await r.json()
    return Object.fromEntries(data.urls.map((u: any) => [u.part_number, u.url]))
  },
  async complete(fileId, uploadId) {
    const r = await fetch(`/uploads/${fileId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: uploadId }),
    })
    if (!r.ok) throw new Error("Erreur lors de la finalisation de l'upload")
  },
}

async function uploadFileSingle(file: File, url: string, index: number, setProgress: SetProgress) {
  await uploadSingle(file, url, (loaded, total) => {
    const pct = Math.round((loaded / total) * 100)
    setProgress(p => ({ ...p, [index]: { pct, done: false } }))
  })
  setProgress(p => ({ ...p, [index]: { pct: 100, done: true } }))
}

async function uploadFileMultipart(file: File, fileId: string, uploadId: string, index: number, setProgress: SetProgress) {
  const sessionFile = getSession()?.files?.find(f => f.file_id === String(fileId))
  await uploadMultipart(file, String(fileId), uploadId, authedEndpoints, {
    localCompleted: sessionFile?.completed_parts ?? [],
    onPartComplete: parts => updateSessionProgress(fileId, parts),
    onProgress: (loaded, total) => {
      const pct = Math.min(99, Math.round((loaded / total) * 100))
      setProgress(p => ({ ...p, [index]: { pct, done: false } }))
    },
  })
  setProgress(p => ({ ...p, [index]: { pct: 100, done: true } }))
}

function uploadFile(file: File, uploadInfo: any, index: number, setProgress: SetProgress) {
  if (uploadInfo.multipart_upload_id)
    return uploadFileMultipart(file, uploadInfo.file_id, uploadInfo.multipart_upload_id, index, setProgress)
  return uploadFileSingle(file, uploadInfo.upload_url, index, setProgress)
}

// ── Sparkline helper ─────────────────────────────────────────────────────────

function generateSparkline(token: string, downloadCount: number): number[] {
  const seed = token.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  const bars = Array.from({ length: 8 }, (_, i) => {
    const pseudo = ((seed * (i + 1) * 7919) % 100)
    return Math.max(10, pseudo % 70 + 10)
  })
  bars[7] = Math.max(bars[6], bars[7])
  const max = Math.max(...bars)
  return bars.map(b => Math.round((b / max) * 100))
}

// ── Component ────────────────────────────────────────────────────────────────

export default function HomePage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuth()

  // Files
  const [files, setFiles] = useState<File[]>([])
  const [fileNames, setFileNames] = useState<string[]>([])
  const thumbUrlsRef = useRef<Record<number, string>>({})
  const [thumbVersion, setThumbVersion] = useState(0)
  const uploadIconRef = useRef<AnimatedIconHandle>(null)

  // Transfer state
  const [shareLink, setShareLink] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sendError, setSendError] = useState('')
  const [progress, setProgress] = useState<Record<number, FileProgress>>({})

  // Transfer configuration
  const [transferName, setTransferName] = useState('')
  const [expiry, setExpiry] = useState('168')
  const [maxDownloads, setMaxDownloads] = useState('')
  const [transferPassword, setTransferPassword] = useState('')
  const [viewMode, setViewMode] = useState<'auto' | 'gallery' | 'list'>('auto')
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Resume
  const [resumeBanner, setResumeBanner] = useState({ show: false, info: '', error: '' })
  const pendingTransferRef = useRef<any>(null)

  // Transfert actif : permet d'ajouter des fichiers sans le recréer (avant ou après confirmation).
  const inFlightRef = useRef(0)
  const confirmingRef = useRef(false)
  const activeTransferRef = useRef<{ token: string; nextIndex: number; confirmed: boolean } | null>(null)
  const [transferActive, setTransferActive] = useState(false)

  // History
  const [history, setHistory] = useState<HistoryTransfer[]>([])
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set())
  const [historySearch, setHistorySearch] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)

  // Preview modal
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)

  // Inline delete confirm
  const [confirmToken, setConfirmToken] = useState<string | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  // Global drag overlay
  const [globalDragOver, setGlobalDragOver] = useState(false)
  const dragCounterRef = useRef(0)

  const stateRef = useRef({ files, fileNames, shareLink, uploading, creating })
  useEffect(() => { stateRef.current = { files, fileNames, shareLink, uploading, creating } })

  useEffect(() => { loadHistory(); checkPendingTransfers() }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { setConfirmToken(null); setBulkConfirm(false) }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    function onDragEnter(e: globalThis.DragEvent) {
      e.preventDefault()
      dragCounterRef.current++
      if (dragCounterRef.current === 1) setGlobalDragOver(true)
    }
    function onDragLeave() {
      dragCounterRef.current--
      if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setGlobalDragOver(false) }
    }
    function onDragOver(e: globalThis.DragEvent) { e.preventDefault() }
    function onDrop(e: globalThis.DragEvent) {
      e.preventDefault()
      dragCounterRef.current = 0
      setGlobalDragOver(false)
      const dropped = e.dataTransfer?.files
      if (dropped && dropped.length > 0) {
        const s = stateRef.current
        if (activeTransferRef.current) {
          // Transfert actif (en cours ou terminé) : on ajoute au lieu de recréer.
          addMoreFiles([...dropped])
        } else if (!s.creating) {
          handleNewFilesWithState([...dropped], s.files, s.fileNames)
        }
      }
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  useEffect(() => () => {
    Object.values(thumbUrlsRef.current).forEach(u => URL.revokeObjectURL(u))
  }, [])

  useEffect(() => {
    if (!previewFile) { setPreviewUrl(null); setPreviewText(null); return }
    const cat = getFileCategory(previewFile)
    if (cat === 'text' || cat === 'code') {
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

  function getEffectiveNameFor(i: number, fls: File[], nms: string[]) {
    const stem = (nms[i] ?? '').trim() || getStem(fls[i].name)
    return stem + getExt(fls[i].name)
  }

  function getEffectiveName(i: number) { return getEffectiveNameFor(i, files, fileNames) }

  function handleNewFilesWithState(newFiles: File[], currentFiles: File[], currentNames: string[]) {
    const allFiles = [...currentFiles, ...newFiles]
    const allNames = [...currentNames, ...newFiles.map(f => getStem(f.name))]
    newFiles.forEach((f, j) => {
      const idx = currentFiles.length + j
      if (getFileCategory(f) === 'image') thumbUrlsRef.current[idx] = URL.createObjectURL(f)
    })
    setThumbVersion(v => v + 1)
    setFiles(allFiles)
    setFileNames(allNames)
  }

  function handleNewFiles(newFiles: File[]) {
    handleNewFilesWithState(newFiles, files, fileNames)
  }

  function removeFile(i: number) {
    if (thumbUrlsRef.current[i]) {
      URL.revokeObjectURL(thumbUrlsRef.current[i])
      delete thumbUrlsRef.current[i]
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
    activeTransferRef.current = null
    inFlightRef.current = 0
    confirmingRef.current = false
    setTransferActive(false)
    setFiles([])
    setFileNames([])
    setShareLink('')
    setSendError('')
    setProgress({})
    setUploading(false)
    setCreating(false)
    setTransferName('')
    setExpiry('168')
    setTransferPassword('')
    setMaxDownloads('')
    setViewMode('auto')
    setAdvancedOpen(false)
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
      setShareLink(resumeData.share_url)
      activeTransferRef.current = { token: pending.token, nextIndex: orderedFiles.length, confirmed: false }
      setTransferActive(true)
      setResumeBanner(b => ({ ...b, show: false }))
      setUploading(true)
      setProgress({})

      await runWithConcurrency(
        resumeData.uploads.map((upload: any, i: number) => () =>
          upload.multipart_upload_id
            ? uploadFileMultipart(orderedFiles[i], upload.file_id, upload.multipart_upload_id, i, setProgress)
            : uploadFileSingle(orderedFiles[i], upload.upload_url, i, setProgress)
        ),
        UPLOAD_CONCURRENCY,
      )

      const confirmRes = await fetch(`/transfers/${pending.token}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      if (!confirmRes.ok) throw new Error(await confirmRes.json().then((d: any) => d.detail).catch(() => 'Erreur'))

      clearSession()
      if (activeTransferRef.current) activeTransferRef.current.confirmed = true
      pendingTransferRef.current = null
      setUploading(false)
      loadHistory()
    } catch (err: any) {
      setResumeBanner(b => ({ ...b, show: true, error: err.message }))
      setUploading(false)
    }
  }

  // ── Start transfer ────────────────────────────────────────────────────────

  // Lance un lot d'uploads en suivant le nombre en vol. Auto-confirme quand
  // plus rien n'est en cours (batch initial + ajouts éventuels).
  async function launchUploads(items: { file: File; info: any; index: number }[]) {
    inFlightRef.current += items.length
    await runWithConcurrency(
      items.map(it => async () => {
        try { await uploadFile(it.file, it.info, it.index, setProgress) }
        finally { inFlightRef.current-- }
      }),
      UPLOAD_CONCURRENCY,
    )
    if (inFlightRef.current === 0) {
      const active = activeTransferRef.current
      if (active && !active.confirmed) await finalizeTransfer()
      else setUploading(false) // transfert déjà confirmé : fin de l'ajout
    }
  }

  async function finalizeTransfer() {
    const active = activeTransferRef.current
    // Rien à faire si déjà confirmé, confirmation en cours, ou uploads encore en vol.
    if (!active || active.confirmed || confirmingRef.current || inFlightRef.current > 0) return
    confirmingRef.current = true
    try {
      const confirmRes = await fetch(`/transfers/${active.token}/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      })
      if (!confirmRes.ok) throw new Error(await confirmRes.json().then((d: any) => d.detail).catch(() => 'Erreur'))

      active.confirmed = true
      clearSession()
      setUploading(false)
      loadHistory()
    } catch (err: any) {
      setSendError(err.message)
      setUploading(false)
    } finally {
      confirmingRef.current = false
    }
  }

  async function startTransfer(filesToSend: File[], namesToSend: string[]) {
    if (filesToSend.length === 0) return
    setSendError('')
    setCreating(true)
    setProgress({})

    try {
      const res = await fetch('/transfers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: filesToSend.map((f, i) => ({
            filename: getEffectiveNameFor(i, filesToSend, namesToSend),
            size_bytes: f.size,
            mime_type: f.type || null,
          })),
          name: transferName.trim() || null,
          expires_in_hours: parseInt(expiry),
          max_downloads: maxDownloads ? parseInt(maxDownloads) : null,
          password: transferPassword || null,
          view_mode: viewMode,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur')
      const transfer = await res.json()

      saveSession(transfer, filesToSend)
      setShareLink(transfer.share_url)
      activeTransferRef.current = { token: transfer.token, nextIndex: filesToSend.length, confirmed: false }
      setTransferActive(true)
      setCreating(false)
      setUploading(true)

      await launchUploads(filesToSend.map((f, i) => ({ file: f, info: transfer.uploads[i], index: i })))
    } catch (err: any) {
      setCreating(false)
      setUploading(false)
      setSendError(err.message)
    }
  }

  // Ajoute des fichiers au transfert en cours (non confirmé) sans le recréer.
  async function addMoreFiles(newFiles: File[]) {
    const active = activeTransferRef.current
    if (!active) {
      // Aucun transfert à alimenter → nouveau transfert.
      handleNewFiles(newFiles)
      return
    }
    setUploading(true) // ré-affiche la progression (cas d'un transfert déjà confirmé)
    const startIndex = active.nextIndex
    active.nextIndex += newFiles.length

    const names = newFiles.map(f => getStem(f.name))
    newFiles.forEach((f, j) => {
      const idx = startIndex + j
      if (getFileCategory(f) === 'image') thumbUrlsRef.current[idx] = URL.createObjectURL(f)
    })
    setThumbVersion(v => v + 1)
    setFiles(prev => [...prev, ...newFiles])
    setFileNames(prev => [...prev, ...names])

    try {
      const res = await fetch(`/transfers/${active.token}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: newFiles.map((f, j) => ({
            filename: (names[j].trim() || getStem(f.name)) + getExt(f.name),
            size_bytes: f.size,
            mime_type: f.type || null,
          })),
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur')
      const data = await res.json()
      active.confirmed = false
      appendSession(active.token, data.uploads, newFiles)
      await launchUploads(newFiles.map((f, j) => ({ file: f, info: data.uploads[j], index: startIndex + j })))
    } catch (err: any) {
      setSendError(err.message)
    }
  }

  function triggerAddFiles() {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => { if (input.files && input.files.length) addMoreFiles([...input.files]) }
    input.click()
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

  async function restoreTransfer(token: string) {
    setDeleteError('')
    try {
      const res = await fetch(`/transfers/${token}/restore`, { method: 'POST' })
      if (!res.ok) {
        const detail = await res.json().then((d: any) => d.detail).catch(() => null)
        setDeleteError(detail || 'Impossible de relancer ce transfert.')
        return
      }
      const { status } = await res.json()
      if (status === 'restored') loadHistory()
      else setHistory(h => h.map(t => t.token === token ? { ...t, is_restoring: true } : t))
    } catch {
      setDeleteError('Impossible de relancer ce transfert.')
    }
  }

  async function handleLogout() {
    await fetch('/auth/logout', { method: 'POST' })
    setUser(null)
    navigate('/login')
  }

  function handleSwitchAccount() {
    window.location.assign('/auth/oidc/login?prompt=login')
  }

  // ── Render ───────────────────────────────────────────────────────────────

  const hasFiles = files.length > 0
  const allDone = hasFiles && Object.keys(progress).length === files.length && Object.values(progress).every(p => p.done)

  const [mode, setMode] = useState<'send' | 'receive'>('send')

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
          {user?.pseudonym && (
            <span title={user.email} style={{ fontSize: 13, color: 'var(--subtext)' }}>
              Connecté en tant que {user.pseudonym}
            </span>
          )}
          {user?.is_admin && (
            <Link to="/admin" className="btn btn-ghost btn-sm">Admin</Link>
          )}
          <a className="btn btn-ghost btn-sm" href="/auth/passerelle/account" target="_blank" rel="noopener noreferrer">Gérer mon compte Passerelle</a>
          <button className="btn btn-ghost btn-sm" onClick={handleSwitchAccount}>Changer de compte</button>
          <button className="btn btn-ghost btn-sm" onClick={handleLogout}>Déconnexion</button>
        </div>
      </header>

      {globalDragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-inner">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p>Déposer pour partager</p>
          </div>
        </div>
      )}

      <main className="page">
        <div className="page-narrow">

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

          <div className="drop-hint">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Glissez des fichiers n'importe où sur la page
          </div>

          <div className="mode-toggle">
            <button className={`mode-toggle-btn${mode === 'send' ? ' active' : ''}`} onClick={() => setMode('send')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 6, verticalAlign: 'middle' }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Envoyer
            </button>
            <button className={`mode-toggle-btn${mode === 'receive' ? ' active' : ''}`} onClick={() => setMode('receive')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: 6, verticalAlign: 'middle' }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Recevoir
            </button>
          </div>

          {mode === 'receive' && <ReceivePage />}

          {mode === 'send' && !hasFiles && (
            <div className="card">
              <div className="card-body">
                <div
                  className="dropzone"
                  onDragOver={(e: DragEvent<HTMLDivElement>) => e.preventDefault()}
                  onClick={() => document.getElementById('fileInput')?.click()}
                  onMouseEnter={() => uploadIconRef.current?.startAnimation()}
                  onMouseLeave={() => uploadIconRef.current?.stopAnimation()}
                >
                  <input id="fileInput" type="file" multiple style={{ display: 'none' }}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      if (e.target.files) { handleNewFiles([...e.target.files]); e.target.value = '' }
                    }} />
                  <div className="dropzone-icon">
                    <UploadIcon ref={uploadIconRef} size={40} strokeWidth={1.5} disableHover />
                  </div>
                  <h2>Déposer vos fichiers ici</h2>
                  <p>ou <span className="browse">parcourir</span> depuis votre appareil</p>
                </div>
              </div>
            </div>
          )}

          {mode === 'send' && hasFiles && (
            <div className="card share-card">
              <div className="share-card-header">
                <div className="share-card-status">
                  {(creating || uploading) && <div className="pulse-dot" />}
                  {shareLink && allDone && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  <span className="share-card-label">
                    {!transferActive ? 'PRÉPARER LE TRANSFERT' : creating ? 'CRÉATION DU LIEN…' : allDone ? 'TRANSFERT TERMINÉ' : 'ENVOI EN COURS'}
                  </span>
                </div>
                {uploading && <span className="share-card-meta">upload en arrière-plan</span>}
              </div>

              <div className="card-body">
                {shareLink && (
                  <div className="share-link-row">
                    <span className="share-link-url">{shareLink}</span>
                    <CopyBtn url={shareLink} style="primary" />
                    <QrPopover url={shareLink} />
                  </div>
                )}

                <ul className="file-list">
                  {files.map((f, i) => {
                    const prog = progress[i] ?? { pct: 0, done: false }
                    const cat = getFileCategory(f)
                    const thumb = thumbUrlsRef.current[i]
                    const canPreview = cat !== 'other'
                    const openFilePreview = () => canPreview && setPreviewFile(f)
                    return (
                      <li key={i} className="file-item">
                        {cat === 'image' && thumb ? (
                          <img className="file-thumb" src={thumb} alt="" title="Aperçu" style={{ cursor: 'pointer' }} onClick={openFilePreview} />
                        ) : (
                          <div className={`file-type-icon${canPreview ? ' previewable' : ''}`} title={canPreview ? 'Aperçu' : undefined} style={canPreview ? { cursor: 'pointer' } : undefined} onClick={openFilePreview}>
                            {cat === 'image' ? <CameraIcon size={16} strokeWidth={2} /> :
                             cat === 'video' ? <BrandZoomIcon size={16} strokeWidth={2} /> :
                             cat === 'code' ? <CodeIcon size={16} strokeWidth={2} /> :
                             <FileDescriptionIcon size={16} strokeWidth={2} />}
                          </div>
                        )}
                        <div className="file-info">
                          <div className="file-name">{getEffectiveName(i)}</div>
                          {(uploading || prog.done) && (
                            <div className="progress">
                              <div className="progress-bar" style={{ width: `${prog.pct}%` }} />
                            </div>
                          )}
                        </div>
                        <span className={`file-status${prog.done ? ' done' : ''}`} style={{ fontFamily: prog.done ? undefined : "'Geist Mono', monospace" }}>
                          {prog.done ? 'Envoyé' : uploading ? `${prog.pct}%` : formatSize(f.size)}
                        </span>
                        {!transferActive && (
                          <button className="file-remove" title={`Retirer ${f.name}`} onClick={() => removeFile(i)}>
                            <TrashIcon size={15} strokeWidth={2} dangerHover />
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>

                {!transferActive ? (
                  <div className="transfer-config">
                    <div className="options-grid">
                      <div className="field">
                        <label htmlFor="transferName">Nom du transfert <span className="field-optional">facultatif</span></label>
                        <input id="transferName" type="text" maxLength={100} placeholder="Ex. Photos du séminaire"
                          value={transferName} onChange={e => setTransferName(e.target.value)} />
                      </div>
                      <div className="field">
                        <label htmlFor="transferExpiry">Expiration</label>
                        <select id="transferExpiry" value={expiry} onChange={e => setExpiry(e.target.value)}>
                          <option value="24">1 jour</option>
                          <option value="72">3 jours</option>
                          <option value="168">7 jours</option>
                          <option value="336">14 jours</option>
                          <option value="720">30 jours</option>
                        </select>
                      </div>
                    </div>

                    <fieldset className="presentation-fieldset">
                      <legend>Présentation aux destinataires</legend>
                      <div className="presentation-options">
                        {([
                          ['auto', 'Automatique', 'Galerie pour les médias, liste pour les documents'],
                          ['gallery', 'Galerie', 'Mettre les images et vidéos en avant'],
                          ['list', 'Liste', 'Afficher tous les fichiers dans une liste compacte'],
                        ] as const).map(([value, label, help]) => (
                          <label key={value} className={`presentation-option${viewMode === value ? ' selected' : ''}`}>
                            <input type="radio" name="viewMode" value={value} checked={viewMode === value}
                              onChange={() => setViewMode(value)} />
                            <span><strong>{label}</strong><small>{help}</small></span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <button className="advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(v => !v)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" />
                        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06A1.7 1.7 0 0 0 19.43 9 1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1Z" />
                      </svg>
                      Options avancées
                      <svg className={advancedOpen ? 'rotated' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9" /></svg>
                    </button>

                    {advancedOpen && (
                      <div className="options-grid advanced-fields">
                        <div className="field">
                          <label htmlFor="transferPassword">Mot de passe <span className="field-optional">facultatif</span></label>
                          <input id="transferPassword" type="password" autoComplete="new-password" placeholder="Protéger l'accès"
                            value={transferPassword} onChange={e => setTransferPassword(e.target.value)} />
                        </div>
                        <div className="field">
                          <label htmlFor="maxDownloads">Nombre maximal de téléchargements <span className="field-optional">facultatif</span></label>
                          <input id="maxDownloads" type="number" min="1" placeholder="Illimité"
                            value={maxDownloads} onChange={e => setMaxDownloads(e.target.value)} />
                        </div>
                      </div>
                    )}

                    <div className="transfer-config-actions">
                      <button className="btn btn-ghost" type="button" onClick={resetTransfer}>Annuler</button>
                      <button className="btn btn-primary" type="button" disabled={creating || files.length === 0}
                        onClick={() => startTransfer(files, fileNames)}>
                        {creating ? <><span className="btn-spinner" aria-hidden="true" />Création…</> : 'Créer le transfert'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="transfer-complete-actions">
                    <button className="btn btn-outline btn-sm" onClick={triggerAddFiles}>Ajouter des fichiers</button>
                    {!uploading && !creating && (
                      <button className="btn btn-ghost btn-sm" onClick={() => { resetTransfer(); setTimeout(() => document.getElementById('fileInput')?.click(), 50) }}>
                        Nouveau transfert
                      </button>
                    )}
                  </div>
                )}

                {sendError && <div className="alert alert-error mt-3">{sendError}</div>}
              </div>
            </div>
          )}
        </div>

        <div className="page-narrow" style={{ marginTop: 28 }}>
          <div className="card">
            {/* En-tête : titre + QuotaBar dégradée */}
            <div className="history-header">
              <span className="history-title">Mes transferts</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {user && user.storage_quota_bytes > 0 && (
                  <QuotaBar used={user.storage_used_bytes} quota={user.storage_quota_bytes} />
                )}
                <button className="btn btn-ghost btn-sm" title="Actualiser" onClick={loadHistory}>
                  <RefreshIcon size={14} strokeWidth={2.5} />
                </button>
              </div>
            </div>

            {/* Barre de recherche */}
            <div className="history-search-bar">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9aa0aa" strokeWidth="2.5">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                placeholder="Rechercher un transfert…"
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
              />
            </div>

            {/* Barre d'actions groupées */}
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
              <div className="alert alert-error" style={{ margin: '0 20px 10px' }}>{deleteError}</div>
            )}

            {history.length === 0 && (
              <div style={{ padding: '20px', color: 'var(--subtext)', fontSize: 13, textAlign: 'center' }}>
                Aucun transfert pour le moment.
              </div>
            )}

            {/* Groupe Actifs */}
            {(() => {
              const search = historySearch.toLowerCase()
              const active = history.filter(t => !t.is_archived && !t.is_restoring && !t.is_expired).filter(t => {
                if (!search) return true
                const displayName = t.name || t.files.map(f => f.filename).join(', ')
                return displayName.toLowerCase().includes(search)
              })
              const archived = history.filter(t => t.is_archived || t.is_restoring || t.is_expired).filter(t => {
                if (!search) return true
                const displayName = t.name || t.files.map(f => f.filename).join(', ')
                return displayName.toLowerCase().includes(search)
              })

              const now = Date.now()

              return (
                <>
                  {active.length > 0 && (
                    <>
                      <div className="history-group-header">
                        Actifs <span className="history-group-count">{active.length}</span>
                      </div>
                      {active.map(t => {
                        const filenames = t.files.map(f => f.filename).join(', ')
                        const displayName = t.name || filenames
                        const totalSize = t.files.reduce((s, f) => s + f.size_bytes, 0)
                        const expiresAt = new Date(t.expires_at).getTime()
                        const msTilExpiry = expiresAt - now
                        const soonExpiring = msTilExpiry < 48 * 3600 * 1000
                        const daysLeft = Math.max(0, Math.ceil(msTilExpiry / (3600 * 1000 * 24)))
                        const checked = selectedTokens.has(t.token)
                        return (
                          <div key={t.token} className={`history-item${checked ? ' selected' : ''}`}>
                            <label className="history-chk-wrap">
                              <input type="checkbox" className="history-chk" checked={checked} onChange={e => toggleToken(t.token, e.target.checked)} />
                            </label>
                            <div className="history-status-dot" style={{ background: soonExpiring ? '#F59E0B' : '#10B981' }} />
                            <div className="history-name-col" title={displayName}>
                              <div className="history-name-text">{displayName}</div>
                              <div className="history-name-meta">
                                {t.files.length} fichier{t.files.length > 1 ? 's' : ''} · {formatSize(totalSize)} · {daysLeft} j restants
                              </div>
                            </div>
                            <div className="history-dl-col">
                              <div className="history-dl-count">{t.max_downloads ? `${t.download_count}/${t.max_downloads}` : t.download_count}</div>
                              <div className="history-dl-label">téléch.</div>
                            </div>
                            {confirmToken === t.token ? (
                              <>
                                <span style={{ fontSize: 12, color: '#991B1B', fontWeight: 500, whiteSpace: 'nowrap' }}>Supprimer ?</span>
                                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmToken(null)}>Non</button>
                                <button className="bulk-delete-btn" onClick={() => confirmDeleteTransfer(t.token)}>Oui</button>
                              </>
                            ) : (
                              <>
                                <CopyIconBtn url={t.share_url} />
                                <button className="history-delete" title="Supprimer" onClick={() => setConfirmToken(t.token)}>
                                  <TrashIcon size={14} strokeWidth={2} dangerHover />
                                </button>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </>
                  )}

                  {archived.length > 0 && (
                    <>
                      <button className="archive-toggle" onClick={() => setArchiveOpen(o => !o)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
                        </svg>
                        Archive — {archived.length} transfert{archived.length > 1 ? 's' : ''} expiré{archived.length > 1 ? 's' : ''}
                        <svg className={`archive-toggle-chevron${archiveOpen ? ' archive-toggle-chevron--open' : ''}`} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <polyline points="6 9 12 15 18 9"/>
                        </svg>
                      </button>

                      {archiveOpen && (
                        <>
                          {archived.map(t => {
                            const filenames = t.files.map(f => f.filename).join(', ')
                            const displayName = t.name || filenames
                            const totalSize = t.files.reduce((s, f) => s + f.size_bytes, 0)
                            const checked = selectedTokens.has(t.token)
                            return (
                              <div key={t.token} className={`history-item history-item--archived${checked ? ' selected' : ''}`}>
                                <label className="history-chk-wrap">
                                  <input type="checkbox" className="history-chk" checked={checked} onChange={e => toggleToken(t.token, e.target.checked)} />
                                </label>
                                <div className="history-status-dot" style={{ background: '#d3d6db' }} />
                                <div className="history-name-col" title={displayName}>
                                  <div className="history-name-text history-name-text--archived">{displayName}</div>
                                  <div className="history-name-meta">
                                    {t.files.length} fichier{t.files.length > 1 ? 's' : ''} · {formatSize(totalSize)} · Expiré le {formatDate(new Date(t.expires_at))}
                                  </div>
                                </div>
                                <div className="history-dl-col">
                                  <div className="history-dl-count history-dl-count--archived">{t.download_count}</div>
                                  <div className="history-dl-label">téléch.</div>
                                </div>
                                {confirmToken === t.token ? (
                                  <>
                                    <span style={{ fontSize: 12, color: '#991B1B', fontWeight: 500, whiteSpace: 'nowrap' }}>Supprimer ?</span>
                                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmToken(null)}>Non</button>
                                    <button className="bulk-delete-btn" onClick={() => confirmDeleteTransfer(t.token)}>Oui</button>
                                  </>
                                ) : t.is_restoring ? (
                                  <>
                                    <span className="restoring-badge">En cours…</span>
                                    <button className="history-delete" title="Supprimer" onClick={() => setConfirmToken(t.token)}>
                                      <TrashIcon size={14} strokeWidth={2} dangerHover />
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <RestoreIconBtn onClick={() => restoreTransfer(t.token)} />
                                    <button className="history-delete" title="Supprimer" onClick={() => setConfirmToken(t.token)}>
                                      <TrashIcon size={14} strokeWidth={2} dangerHover />
                                    </button>
                                  </>
                                )}
                              </div>
                            )
                          })}
                          <div className="archive-footer">Conservés en stockage froid — Relancer les remet en ligne</div>
                        </>
                      )}
                    </>
                  )}
                </>
              )
            })()}
          </div>
        </div>
      </main>

      <input id="fileInput" type="file" multiple style={{ display: 'none' }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          if (e.target.files) { handleNewFiles([...e.target.files]); e.target.value = '' }
        }} />

      {previewFile && (() => {
        const cat = getFileCategory(previewFile)
        const kind: PreviewKind = cat === 'code' ? 'text' : cat as PreviewKind
        return (
          <PreviewModal
            filename={previewFile.name}
            kind={kind}
            src={previewUrl}
            text={previewText}
            onClose={() => setPreviewFile(null)}
          />
        )
      })()}
    </>
  )
}

// ── Small components ─────────────────────────────────────────────────────────

function QuotaBar({ used, quota }: { used: number; quota: number }) {
  const pct = Math.min(100, Math.round(used / quota * 100))
  const usedStr = formatBytes(used)
  const quotaStr = formatBytes(quota)
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 11, color: 'var(--subtext)', marginBottom: 4, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <span>Espace utilisé</span>
        <span style={{ fontFamily: "'Geist Mono', monospace", color: 'var(--text)', fontWeight: 500 }}>{usedStr} / {quotaStr}</span>
      </div>
      <div style={{ width: 190, height: 6, background: '#EEF0F2', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, #0D9488, #10B981)', borderRadius: 3 }} />
      </div>
    </div>
  )
}

function CopyBtn({ url, style }: { url: string; style: 'primary' | 'small' }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  if (style === 'small') {
    return <button className={`history-copy${copied ? ' copied' : ''}`} onClick={copy}>{copied ? 'Copié' : 'Copier'}</button>
  }
  return <button className={`copy-btn${copied ? ' copied' : ''}`} onClick={copy}>{copied ? 'Copié' : 'Copier'}</button>
}

function CopyIconBtn({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  function copy(e: MouseEvent) {
    e.stopPropagation()
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button className={`history-icon-btn${copied ? ' copied' : ''}`} title={copied ? 'Copié !' : 'Copier le lien'} onClick={copy}>
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      ) : (
        <CopyIcon size={14} strokeWidth={2} />
      )}
    </button>
  )
}

function RestoreIconBtn({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button className="history-icon-btn history-icon-btn--restore" title="Relancer" onClick={onClick} disabled={disabled}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.97"/>
      </svg>
    </button>
  )
}
