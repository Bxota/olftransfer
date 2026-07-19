import { useEffect } from 'react'

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text'

interface PreviewModalProps {
  filename: string
  kind: PreviewKind
  src?: string | null
  text?: string | null
  onClose: () => void
  onDownload?: () => void
  onPrevious?: () => void
  onNext?: () => void
}

export function PreviewModal({ filename, kind, src, text, onClose, onDownload, onPrevious, onNext }: PreviewModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onPrevious?.()
      if (e.key === 'ArrowRight') onNext?.()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose, onPrevious, onNext])

  return (
    <div className="preview-modal" role="dialog" aria-modal="true" aria-label={`Aperçu de ${filename}`}>
      <div className="preview-backdrop" onClick={onClose} />
      <div className="preview-container">
        <div className="preview-header">
          <span className="preview-filename">{filename}</span>
          <div className="preview-actions">
            {onDownload && (
              <button className="preview-action-btn" title="Télécharger" onClick={onDownload}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
            )}
            <button className="preview-close" title="Fermer (Échap)" onClick={onClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div className="preview-body" style={kind === 'text' ? { background: '#1e1e1e' } : kind === 'audio' ? { background: 'var(--bg)' } : {}}>
          {kind === 'text' && text != null && <pre>{text}</pre>}
          {kind === 'image' && src && <img src={src} alt={filename} />}
          {kind === 'video' && src && <video src={src} controls autoPlay={false} />}
          {kind === 'audio' && src && <audio src={src} controls />}
          {kind === 'pdf' && src && <iframe src={src} title={filename} style={{ background: 'white' }} />}
          {onPrevious && <button className="preview-nav preview-nav--previous" onClick={onPrevious} title="Fichier précédent" aria-label="Fichier précédent"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6" /></svg></button>}
          {onNext && <button className="preview-nav preview-nav--next" onClick={onNext} title="Fichier suivant" aria-label="Fichier suivant"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6" /></svg></button>}
        </div>
      </div>
    </div>
  )
}
