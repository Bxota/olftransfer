import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { QRCodeSVG } from 'qrcode.react'

export function QrPopover({ url, style }: { url: string; style?: React.CSSProperties }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, right: 0 })

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const rect = btnRef.current.getBoundingClientRect()
    setPos({
      top: rect.bottom + window.scrollY + 8,
      right: window.innerWidth - rect.right,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    function onOut(e: MouseEvent) {
      if (
        btnRef.current && !btnRef.current.contains(e.target as Node) &&
        popoverRef.current && !popoverRef.current.contains(e.target as Node)
      ) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onOut)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onOut) }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        className="qr-btn"
        title="Afficher le QR code"
        onClick={() => setOpen(o => !o)}
        style={style}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
          <rect x="14" y="2" width="8" height="8" rx="1.5" />
          <rect x="2" y="14" width="8" height="8" rx="1.5" />
          <rect x="4.5" y="4.5" width="3" height="3" fill="currentColor" stroke="none" />
          <rect x="16.5" y="4.5" width="3" height="3" fill="currentColor" stroke="none" />
          <rect x="4.5" y="16.5" width="3" height="3" fill="currentColor" stroke="none" />
          <line x1="14" y1="14" x2="14" y2="14.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="18" y1="14" x2="18" y2="14.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="22" y1="14" x2="22" y2="14.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="14" y1="18" x2="14" y2="18.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="18" y1="18" x2="18" y2="18.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="22" y1="18" x2="22" y2="18.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="14" y1="22" x2="14" y2="22.01" strokeWidth="3" strokeLinecap="round" />
          <line x1="22" y1="22" x2="22" y2="22.01" strokeWidth="3" strokeLinecap="round" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="qr-popover"
          style={{ position: 'absolute', top: pos.top, right: pos.right, zIndex: 9999 }}
        >
          <p className="qr-popover-title">Scanner pour ouvrir</p>
          <div className="qr-code-wrap">
            <QRCodeSVG value={url} size={160} level="M" includeMargin />
          </div>
          <p className="qr-popover-hint">Pointez l'appareil photo du téléphone</p>
        </div>,
        document.body
      )}
    </>
  )
}
