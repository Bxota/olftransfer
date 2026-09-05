import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { formatSize, formatDateLong, runWithConcurrency } from '../lib/utils'
import { QrPopover } from '../components/QrPopover'
import { PreviewModal, PreviewKind } from '../components/PreviewModal'

interface TransferFile {
  filename: string
  size_bytes: number
  mime_type?: string | null
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
  view_mode: 'auto' | 'gallery' | 'list'
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

function isPhotoFile(filename: string): boolean {
  return /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?)$/i.test(filename)
}

function supportsMobilePhotoShare(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia('(pointer: coarse)').matches) return false
  // Certains navigateurs Android savent partager des fichiers mais n'exposent
  // pas `canShare`, ou répondent faux avant que les vrais fichiers soient prêts.
  return typeof navigator.share === 'function'
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

function isGalleryFile(filename: string): boolean {
  return isImageFile(filename) || isVideoFile(filename)
}

function isGallerySaveableFile(filename: string): boolean {
  return isPhotoFile(filename) || isVideoFile(filename)
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
  const galleryObserversRef = useRef(new Map<number, IntersectionObserver>())

  // Preview modal
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewFilename, setPreviewFilename] = useState<string | null>(null)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState<number | null>(null)
  const [previewFiles, setPreviewFiles] = useState<{ filename: string; download_url: string; thumbnail_url?: string | null }[]>([])
  const [visibleGalleryFiles, setVisibleGalleryFiles] = useState<Set<number>>(() => new Set())
  const [loadedGalleryFiles, setLoadedGalleryFiles] = useState<Set<number>>(() => new Set())
  const [failedGalleryFiles, setFailedGalleryFiles] = useState<Set<number>>(() => new Set())
  const [displayMode, setDisplayMode] = useState<'gallery' | 'list' | null>(null)
  const [photoShareFiles, setPhotoShareFiles] = useState<File[] | null>(null)
  const [preparingPhotos, setPreparingPhotos] = useState(false)
  const [savingPhotos, setSavingPhotos] = useState(false)
  const [photoSaveError, setPhotoSaveError] = useState('')

  // Download in-flight (anti spam-click)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [downloadingFile, setDownloadingFile] = useState<number | null>(null)

  useEffect(() => { loadTransfer() }, [token])

  useEffect(() => () => {
    galleryObserversRef.current.forEach(observer => observer.disconnect())
    galleryObserversRef.current.clear()
  }, [])

  useEffect(() => {
    if (state !== 'ready' || !transfer || previewFiles.length > 0) return
    const preferredMode = transfer.view_mode === 'gallery'
      || (transfer.view_mode === 'auto' && transfer.files.some(file => isGalleryFile(file.filename)))
    const needsPhotoShare = transfer.files.length > 0
      && transfer.files.every(file => isGallerySaveableFile(file.filename))
      && supportsMobilePhotoShare()
    if (preferredMode || needsPhotoShare) void getPreviewUrls()
  }, [state, transfer, previewFiles.length])

  useEffect(() => {
    if (photoShareFiles) return
    if (state !== 'ready' || !transfer || previewFiles.length !== transfer.files.length) return
    if (!supportsMobilePhotoShare() || !transfer.files.every(file => isGallerySaveableFile(file.filename))) return
    const photoTransfer = transfer

    const controller = new AbortController()
    let cancelled = false

    async function preparePhotos() {
      setPreparingPhotos(true)
      try {
        const files: File[] = new Array(previewFiles.length)
        await runWithConcurrency(previewFiles.map((preview, index) => async () => {
          const response = await fetch(preview.download_url, { signal: controller.signal })
          if (!response.ok) throw new Error('Image inaccessible')
          const blob = await response.blob()
          const type = blob.type || photoTransfer.files[index].mime_type || 'image/jpeg'
          files[index] = new File([blob], preview.filename, { type })
        }), 3)
        if (!cancelled) setPhotoShareFiles(files)
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === 'AbortError')) {
          setPhotoSaveError("Les fichiers n'ont pas pu être préparés. Ouvrez le lien dans Chrome ou Safari, puis réessayez.")
        }
      } finally {
        if (!cancelled) setPreparingPhotos(false)
      }
    }

    void preparePhotos()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [state, transfer, previewFiles])

  function closePreview() { setPreviewUrl(null); setPreviewFilename(null); setPreviewIndex(null) }

  async function loadTransfer() {
    setPhotoShareFiles(null)
    setPreparingPhotos(false)
    setPreviewFiles([])
    setVisibleGalleryFiles(new Set())
    setLoadedGalleryFiles(new Set())
    setFailedGalleryFiles(new Set())
    galleryObserversRef.current.forEach(observer => observer.disconnect())
    galleryObserversRef.current.clear()
    setPhotoSaveError('')
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

  async function getDownloadUrls(): Promise<{ filename: string; download_url: string }[] | null> {
    const p = new URLSearchParams()
    if (passwordRef.current) p.set('password', passwordRef.current)
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

  async function getPreviewUrls(): Promise<{ filename: string; download_url: string; thumbnail_url?: string | null }[] | null> {
    if (previewFiles.length > 0) return previewFiles
    const params = passwordRef.current ? `?password=${encodeURIComponent(passwordRef.current)}` : ''
    const res = await fetch(`/transfers/${token}/preview${params}`)
    if (res.status === 401) { setState('password'); return null }
    if (res.status === 403) { setPwError('Mot de passe incorrect.'); setState('password'); return null }
    if (!res.ok) return null
    const files = (await res.json()).files
    setPreviewFiles(files)
    return files
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

  async function savePhotos() {
    if (!photoShareFiles || savingPhotos) return
    setPhotoSaveError('')
    setSavingPhotos(true)
    try {
      if (typeof navigator.canShare === 'function' && !navigator.canShare({ files: photoShareFiles })) {
        throw new Error('Partage de fichiers non pris en charge')
      }
      await navigator.share({
        files: photoShareFiles,
        title: transfer?.name || 'Photos OlfTransfer',
      })

      // Le partage réussi représente un téléchargement. On enregistre l'événement
      // après la fermeture du panneau natif afin de préserver le geste utilisateur.
      const params = passwordRef.current ? `?password=${encodeURIComponent(passwordRef.current)}` : ''
      const response = await fetch(`/transfers/${token}/download${params}`)
      if (response.ok) {
        setTransfer(current => current ? { ...current, download_count: current.download_count + 1 } : current)
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setPhotoSaveError("Le téléphone n'a pas pu ouvrir l'enregistrement des photos.")
      }
    } finally {
      setSavingPhotos(false)
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
    const files = await getPreviewUrls()
    setPreviewLoading(null)
    if (!files) return
    setPreviewFilename(filename)
    setPreviewIndex(index)
    setPreviewUrl(files[index].download_url)
  }

  async function movePreview(direction: -1 | 1) {
    if (!transfer || previewIndex === null) return
    const previewable = transfer.files.map((file, index) => isPreviewable(file.filename) ? index : -1).filter(index => index >= 0)
    const current = previewable.indexOf(previewIndex)
    const next = previewable[(current + direction + previewable.length) % previewable.length]
    await openPreview(next, transfer.files[next].filename)
  }

  // Ne donne une source aux médias que lorsqu'ils approchent de l'écran. Cela
  // complète `loading=lazy`, dont le seuil et le nombre de téléchargements en
  // parallèle sont laissés au navigateur et trop généreux sur les grandes listes.
  function observeGalleryItem(index: number) {
    return (element: HTMLButtonElement | null) => {
      if (!element || visibleGalleryFiles.has(index) || galleryObserversRef.current.has(index)) return
      const observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisibleGalleryFiles(current => current.has(index) ? current : new Set(current).add(index))
          observer.disconnect()
          galleryObserversRef.current.delete(index)
        }
      }, { rootMargin: '300px 0px' })
      galleryObserversRef.current.set(index, observer)
      observer.observe(element)
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

      <main className="page public-surface transfer-page">
        <div className="page-narrow">
          {state === 'loading' && (
            <div className="text-center text-subtext">Chargement…</div>
          )}

          {state === 'password' && (
            <div className="card">
              <div className="card-body" style={{ textAlign: 'center', paddingBottom: 0 }}>
                <div style={{ width: 46, height: 46, borderRadius: '50%', border: '2px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 13px', color: 'var(--subtext)' }}><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>
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
                  {isExpired ? <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg> : '!'}
                </div>
                <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 5 }}>{errorTitle}</h2>
                <p className="text-subtext" style={{ fontSize: 12.5, lineHeight: 1.45, marginBottom: isExpired ? 18 : 0 }}>{errorMsg}</p>
                {isExpired && (
                  <a href="mailto:?subject=Nouveau lien OlfTransfer&body=Bonjour, pourriez-vous m'envoyer un nouveau lien ?" className="btn btn-outline btn-full" style={{ display: 'flex' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/></svg>
                    Demander un nouveau lien
                  </a>
                )}
              </div>
            </div>
          )}

          {state === 'ready' && transfer && (() => {
            const totalSize = transfer.files.reduce((s, f) => s + f.size_bytes, 0)
            const expiryDays = getExpiryDays(transfer.expires_at)
            const hasGalleryFiles = transfer.files.some(file => isGalleryFile(file.filename))
            const defaultDisplayMode = transfer.view_mode === 'list' || !hasGalleryFiles ? 'list' : 'gallery'
            const currentDisplayMode = displayMode ?? defaultDisplayMode
            const gallerySaveTransfer = transfer.files.length > 0
              && transfer.files.every(file => isGallerySaveableFile(file.filename))
              && supportsMobilePhotoShare()
            const listedFiles = currentDisplayMode === 'gallery'
              ? transfer.files.map((file, index) => ({ file, index })).filter(({ file }) => !isGalleryFile(file.filename))
              : transfer.files.map((file, index) => ({ file, index }))

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
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                      Expire {expiryDays === 0 ? "aujourd'hui" : `dans ${expiryDays} jour${expiryDays > 1 ? 's' : ''}`}
                    </span>
                    {transfer.max_downloads && (
                      <span style={{ fontSize: 12, color: 'var(--subtext)' }}>
                        {transfer.download_count}/{transfer.max_downloads} téléch.
                      </span>
                    )}
                  </div>

                  <div className="recipient-primary-actions">
                  {gallerySaveTransfer ? (
                    <>
                      <button className="btn btn-primary save-photos-btn" onClick={savePhotos} disabled={savingPhotos || preparingPhotos || !photoShareFiles}>
                        {preparingPhotos ? (
                          <><span className="btn-spinner" aria-hidden="true" />Préparation des fichiers…</>
                        ) : savingPhotos ? (
                          <><span className="btn-spinner" aria-hidden="true" />Ouverture de Photos…</>
                        ) : (
                          <>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                              <rect x="3" y="4" width="18" height="16" rx="2" />
                              <circle cx="8.5" cy="9" r="1.5" />
                              <path d="m21 15-5-5L5 20" />
                              <path d="M12 7v7m-3-3 3 3 3-3" />
                            </svg>
                            Enregistrer dans la galerie
                          </>
                        )}
                      </button>
                      <button className="recipient-download-icon" onClick={downloadAll} disabled={downloadingAll}
                        title="Télécharger les fichiers" aria-label="Télécharger les fichiers">
                        {downloadingAll ? <span className="btn-spinner btn-spinner--dark" aria-hidden="true" /> : (
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                        )}
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-primary recipient-download-all" onClick={downloadAll} disabled={downloadingAll}>
                      {downloadingAll ? (
                        <><span className="btn-spinner" aria-hidden="true" />Préparation du téléchargement…</>
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
                  )}
                  <QrPopover url={window.location.href} style={{ height: 'auto', width: 56, borderRadius: 11 }} />
                  </div>
                  {photoSaveError && <div className="alert alert-error photo-save-error">{photoSaveError}</div>}

                  <div className="files-section-header">
                    <p className="section-label">Fichiers</p>
                    {hasGalleryFiles && (
                      <div className="view-toggle" aria-label="Mode d'affichage">
                        <button className={currentDisplayMode === 'gallery' ? 'active' : ''} onClick={() => setDisplayMode('gallery')} title="Afficher la galerie" aria-label="Afficher la galerie">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                        </button>
                        <button className={currentDisplayMode === 'list' ? 'active' : ''} onClick={() => setDisplayMode('list')} title="Afficher la liste" aria-label="Afficher la liste">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
                        </button>
                      </div>
                    )}
                  </div>

                  {currentDisplayMode === 'gallery' && (
                    <div className="transfer-gallery">
                      {transfer.files.map((file, index) => isGalleryFile(file.filename) && (
                        <button key={index} ref={observeGalleryItem(index)} className="gallery-item" onClick={() => openPreview(index, file.filename)} disabled={previewLoading !== null}>
                          {isImageFile(file.filename) && visibleGalleryFiles.has(index) && previewFiles[index]?.download_url ? (
                            <>
                              {!loadedGalleryFiles.has(index) && !failedGalleryFiles.has(index) && <span className="gallery-media-loader" aria-label="Chargement de l’image"><span className="btn-spinner btn-spinner--dark" /></span>}
                              <img
                                className={loadedGalleryFiles.has(index) ? 'gallery-media-ready' : 'gallery-media-pending'}
                                src={previewFiles[index].thumbnail_url ?? previewFiles[index].download_url}
                                alt={file.filename}
                                loading="lazy"
                                decoding="async"
                                onLoad={() => setLoadedGalleryFiles(current => current.has(index) ? current : new Set(current).add(index))}
                                onError={() => setFailedGalleryFiles(current => current.has(index) ? current : new Set(current).add(index))}
                              />
                              {failedGalleryFiles.has(index) && <span className="gallery-placeholder" aria-label="Vignette indisponible">
                                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                              </span>}
                            </>
                          ) : isVideoFile(file.filename) && visibleGalleryFiles.has(index) && previewFiles[index]?.download_url ? (
                            <video src={previewFiles[index].download_url} preload="none" muted />
                          ) : (
                            <span className="gallery-placeholder">
                              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                            </span>
                          )}
                          <span className="gallery-caption">
                            <strong>{file.filename}</strong>
                            <small>{formatSize(file.size_bytes)}</small>
                          </span>
                          {previewLoading === index && <span className="gallery-loading"><span className="btn-spinner" /></span>}
                        </button>
                      ))}
                    </div>
                  )}

                  {listedFiles.length > 0 && currentDisplayMode === 'gallery' && <p className="section-label files-other-label">Autres fichiers</p>}
                  {listedFiles.length > 0 && (
                  <div className="transfer-file-list">
                    {listedFiles.map(({ file: f, index: i }) => {
                      const ext = getFileExt(f.filename)
                      const canPreview = isPreviewable(f.filename)
                      const loading = previewLoading === i

                      return (
                        <div key={i} className="transfer-file-row">
                          <div className="transfer-file-type">{ext}</div>
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
                  )}

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
            onPrevious={transfer && transfer.files.filter(file => isPreviewable(file.filename)).length > 1 ? () => movePreview(-1) : undefined}
            onNext={transfer && transfer.files.filter(file => isPreviewable(file.filename)).length > 1 ? () => movePreview(1) : undefined}
          />
        )
      })()}
    </>
  )
}
