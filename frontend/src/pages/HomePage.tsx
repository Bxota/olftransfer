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
import { PreviewModal, PreviewKind } from '../components/PreviewModal'

// ── Types ────────────────────────────────────────────────────────────────────

interface TransferFile { filename: string; size_bytes: number; mime_type: string }
interface HistoryTransfer {
  token: string; name: string | null; share_url: string; created_at: string; expires_at: string
  is_expired: boolean; is_archived: boolean; is_restoring: boolean
  download_count: number; max_downloads: number | null
  has_password: boolean; files: TransferFile[]
}
interface FileProgress { pct: number; done: boolean }
interface VirusWarning { filename: string; virus: string }

// ── Upload session (localStorage) ───────────────────────────────────────────

const CHUNK_SIZE = 100 * 1024 * 1024
const UPLOAD_CONCURRENCY = 3

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
  chunk: Blob, url: string, partNumber: number,
  onProgress: (partNumber: number, loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(partNumber, e.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(partNumber, chunk.size); resolve() }
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

  // Progression par octets pour supporter les parts uploadées en parallèle
  const loadedByPart: Record<number, number> = {}
  completedParts.forEach(pn => {
    loadedByPart[pn] = Math.min(CHUNK_SIZE, file.size - (pn - 1) * CHUNK_SIZE)
  })
  function reportProgress(partNumber: number, loaded: number) {
    loadedByPart[partNumber] = loaded
    const totalLoaded = Object.values(loadedByPart).reduce((a, b) => a + b, 0)
    const pct = Math.min(99, Math.round((totalLoaded / file.size) * 100))
    setProgress(p => ({ ...p, [index]: { pct, done: false } }))
  }
  if (completedParts.length > 0) reportProgress(completedParts[0], loadedByPart[completedParts[0]])

  const partTasks: (() => Promise<void>)[] = []
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    if (completedParts.includes(partNumber)) continue
    partTasks.push(async () => {
      const urlRes = await fetch(`/uploads/${fileId}/part-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: uploadId, part_number: partNumber }),
      })
      if (!urlRes.ok) throw new Error(`Impossible d'obtenir l'URL de la partie ${partNumber}`)
      const { url } = await urlRes.json()
      const start = (partNumber - 1) * CHUNK_SIZE
      await uploadPart(file.slice(start, start + CHUNK_SIZE), url, partNumber, reportProgress)
      completedParts = [...completedParts, partNumber]
      updateSessionProgress(fileId, completedParts)
    })
  }
  await runWithConcurrency(partTasks, UPLOAD_CONCURRENCY)

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
  const [shareToken, setShareToken] = useState('')
  const [shareLink, setShareLink] = useState('')
  const [creating, setCreating] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sendError, setSendError] = useState('')
  const [progress, setProgress] = useState<Record<number, FileProgress>>({})

  // Chip popovers
  const [openChip, setOpenChip] = useState<'name' | 'expiry' | 'password' | 'maxdl' | null>(null)
  const [chipName, setChipName] = useState('')
  const [chipExpiry, setChipExpiry] = useState('168')
  const [chipPassword, setChipPassword] = useState('')
  const [chipMaxDl, setChipMaxDl] = useState('')
  const [chipSaving, setChipSaving] = useState(false)

  // Options
  const [expiry, setExpiry] = useState('168')
  const [maxDownloads, setMaxDownloads] = useState('')
  const [transferPassword, setTransferPassword] = useState('')

  // Resume
  const [resumeBanner, setResumeBanner] = useState({ show: false, info: '', error: '' })
  const pendingTransferRef = useRef<any>(null)

  // History
  const [history, setHistory] = useState<HistoryTransfer[]>([])
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set())
  const [historySearch, setHistorySearch] = useState('')
  const [archiveOpen, setArchiveOpen] = useState(false)

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
        if (!s.uploading && !s.creating) {
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
    startTransfer(allFiles, allNames)
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
    setFiles([])
    setFileNames([])
    setShareToken('')
    setShareLink('')
    setSendError('')
    setProgress({})
    setUploading(false)
    setCreating(false)
    setOpenChip(null)
    setChipName('')
    setChipExpiry('168')
    setChipPassword('')
    setChipMaxDl('')
  }

  async function patchTransfer(patch: {
    name?: string
    expires_in_hours?: number
    password?: string
    remove_password?: boolean
    max_downloads?: number
    remove_max_downloads?: boolean
  }) {
    if (!shareToken) return
    setChipSaving(true)
    try {
      await fetch(`/transfers/${shareToken}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
    } finally {
      setChipSaving(false)
      setOpenChip(null)
    }
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
      setShareLink(resumeData.share_url)
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
      setUploading(false)
      loadHistory()
    } catch (err: any) {
      setResumeBanner(b => ({ ...b, show: true, error: err.message }))
      setUploading(false)
    }
  }

  // ── Start transfer ────────────────────────────────────────────────────────

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
          name: chipName.trim() || null,
          expires_in_hours: parseInt(expiry),
          max_downloads: maxDownloads ? parseInt(maxDownloads) : null,
          password: transferPassword || null,
        }),
      })
      if (!res.ok) throw new Error((await res.json()).detail || 'Erreur serveur')
      const transfer = await res.json()

      saveSession(transfer, filesToSend)
      setShareToken(transfer.token)
      setShareLink(transfer.share_url)
      setChipExpiry(expiry)
      setChipPassword(transferPassword)
      setChipMaxDl(maxDownloads)
      setCreating(false)
      setUploading(true)

      await runWithConcurrency(
        filesToSend.map((f, i) => () => uploadFile(f, transfer.uploads[i], i, setProgress)),
        UPLOAD_CONCURRENCY,
      )

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
      setUploading(false)
      loadHistory()
    } catch (err: any) {
      setCreating(false)
      setUploading(false)
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

  // ── Render ───────────────────────────────────────────────────────────────

  // Close chip popovers on outside click
  useEffect(() => {
    if (!openChip) return
    function onOutside() { setOpenChip(null) }
    document.addEventListener('click', onOutside)
    return () => document.removeEventListener('click', onOutside)
  }, [openChip])

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
          {user?.is_admin && (
            <Link to="/admin" className="btn btn-ghost btn-sm">Admin</Link>
          )}
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
                  {!allDone && <div className="pulse-dot" />}
                  {allDone && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0F766E" strokeWidth="2.5">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                  <span className="share-card-label">
                    {creating ? 'CRÉATION DU LIEN…' : allDone ? 'TRANSFERT TERMINÉ' : 'LIEN ACTIF — PARTAGEABLE MAINTENANT'}
                  </span>
                </div>
                {uploading && <span className="share-card-meta">upload en arrière-plan</span>}
              </div>

              <div className="card-body">
                <div className="share-link-row">
                  <span className={`share-link-url${!shareLink ? ' share-link-url--loading' : ''}`}>
                    {shareLink || 'Génération du lien…'}
                  </span>
                  {shareLink && <CopyBtn url={shareLink} style="primary" />}
                  {shareLink && <QrPopover url={shareLink} />}
                </div>

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
                      </li>
                    )
                  })}
                </ul>

                <div className="chip-options" onClick={e => e.stopPropagation()}>
                  {/* Name chip */}
                  <div className="chip-wrap">
                    <button className={`chip ${chipName ? 'chip-active' : 'chip-inactive'}`} onClick={() => setOpenChip(openChip === 'name' ? null : 'name')}>
                      {chipName ? `🏷 ${chipName} ▾` : '🏷 Nommer le transfert'}
                    </button>
                    {openChip === 'name' && (
                      <div className="chip-popover">
                        <input type="text" placeholder="Nom du transfert" maxLength={100} value={chipName}
                          onChange={e => setChipName(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && patchTransfer({ name: chipName.trim() })}
                          autoFocus />
                        <div className="chip-popover-actions">
                          {chipName && <button className="chip-popover-remove" disabled={chipSaving} onClick={() => { setChipName(''); patchTransfer({ name: '' }) }}>Retirer</button>}
                          <button className="chip-popover-cancel" onClick={() => setOpenChip(null)}>Annuler</button>
                          <button className="chip-popover-save" disabled={chipSaving} onClick={() => patchTransfer({ name: chipName.trim() })}>
                            {chipSaving ? '…' : 'Appliquer'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Expiry chip */}
                  <div className="chip-wrap">
                    <button className="chip chip-active" onClick={() => setOpenChip(openChip === 'expiry' ? null : 'expiry')}>
                      ⏱ Expire dans {chipExpiry === '24' ? '1 jour' : chipExpiry === '72' ? '3 jours' : chipExpiry === '168' ? '7 jours' : chipExpiry === '336' ? '14 jours' : '30 jours'} ▾
                    </button>
                    {openChip === 'expiry' && (
                      <div className="chip-popover">
                        <select value={chipExpiry} onChange={e => setChipExpiry(e.target.value)}>
                          <option value="24">1 jour</option>
                          <option value="72">3 jours</option>
                          <option value="168">7 jours</option>
                          <option value="336">14 jours</option>
                          <option value="720">30 jours</option>
                        </select>
                        <div className="chip-popover-actions">
                          <button className="chip-popover-cancel" onClick={() => setOpenChip(null)}>Annuler</button>
                          <button className="chip-popover-save" disabled={chipSaving} onClick={() => patchTransfer({ expires_in_hours: parseInt(chipExpiry) })}>
                            {chipSaving ? '…' : 'Appliquer'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Password chip */}
                  <div className="chip-wrap">
                    <button className={`chip ${chipPassword ? 'chip-active' : 'chip-inactive'}`} onClick={() => setOpenChip(openChip === 'password' ? null : 'password')}>
                      {chipPassword ? '🔒 Protégé ▾' : '＋ Mot de passe'}
                    </button>
                    {openChip === 'password' && (
                      <div className="chip-popover">
                        <input type="password" placeholder="Nouveau mot de passe" value={chipPassword} onChange={e => setChipPassword(e.target.value)} autoFocus />
                        <div className="chip-popover-actions">
                          {chipPassword && <button className="chip-popover-remove" disabled={chipSaving} onClick={() => { setChipPassword(''); patchTransfer({ remove_password: true }) }}>Retirer</button>}
                          <button className="chip-popover-cancel" onClick={() => setOpenChip(null)}>Annuler</button>
                          <button className="chip-popover-save" disabled={chipSaving} onClick={() => patchTransfer({ password: chipPassword })}>
                            {chipSaving ? '…' : 'Appliquer'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Max downloads chip */}
                  <div className="chip-wrap">
                    <button className={`chip ${chipMaxDl ? 'chip-active' : 'chip-inactive'}`} onClick={() => setOpenChip(openChip === 'maxdl' ? null : 'maxdl')}>
                      {chipMaxDl ? `⤓ ${chipMaxDl} téléch. max ▾` : '⤓ Limiter téléchargements'}
                    </button>
                    {openChip === 'maxdl' && (
                      <div className="chip-popover">
                        <input type="number" placeholder="Illimité" min="1" value={chipMaxDl} onChange={e => setChipMaxDl(e.target.value)} autoFocus />
                        <div className="chip-popover-actions">
                          {chipMaxDl && <button className="chip-popover-remove" disabled={chipSaving} onClick={() => { setChipMaxDl(''); patchTransfer({ remove_max_downloads: true }) }}>Retirer</button>}
                          <button className="chip-popover-cancel" onClick={() => setOpenChip(null)}>Annuler</button>
                          <button className="chip-popover-save" disabled={chipSaving} onClick={() => patchTransfer({ max_downloads: chipMaxDl ? parseInt(chipMaxDl) : undefined })}>
                            {chipSaving ? '…' : 'Appliquer'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {!uploading && !creating && (
                    <button className="chip chip-inactive" onClick={() => { resetTransfer(); setTimeout(() => document.getElementById('fileInput')?.click(), 50) }}>
                      ＋ Nouveau transfert
                    </button>
                  )}
                </div>

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
                          <div className="archive-footer">❄ Conservés en stockage froid — Relancer les remet en ligne</div>
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
