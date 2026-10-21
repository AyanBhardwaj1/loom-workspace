import { ExternalLink, RotateCw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { IconButton, Pill } from './primitives'

/**
 * Renders a session's (or merged main's) live-built product in a sandboxed
 * iframe. `sandbox="allow-scripts"` gives the frame an opaque origin — it can
 * run its own JS but cannot reach our DOM, cookies, or (with the server's
 * `connect-src 'none'` CSP) our API. We reload by remounting the iframe with a
 * cache-busting token whenever `reloadKey` changes (a new commit).
 */
export function PreviewPane({
  src,
  reloadKey,
  onClose,
  label,
}: {
  /** e.g. `/preview/session/:id/` — always a trailing slash so relative assets resolve */
  src: string
  /** bump to force a reload (typically the latest commit seq) */
  reloadKey: number | string
  onClose?: () => void
  label?: string
}) {
  const [manualNonce, setManualNonce] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const bustedSrc = useMemo(() => {
    const sep = src.includes('?') ? '&' : '?'
    return `${src}${sep}_v=${reloadKey}-${manualNonce}`
  }, [src, reloadKey, manualNonce])

  // brief "updated" pill when a new commit reloads the preview
  const [flash, setFlash] = useState(false)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1600)
    return () => clearTimeout(t)
  }, [reloadKey])

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col border-l border-hairline bg-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className="text-small font-medium text-tertiary">Preview</span>
        {label && <span className="min-w-0 truncate font-mono text-code-sm text-tertiary">{label}</span>}
        {flash && <Pill tone="ok">updated</Pill>}
        <div className="ml-auto flex items-center gap-0.5">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            title="Open the preview in a new tab"
            aria-label="Open the preview in a new tab"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
          >
            <ExternalLink size={14} strokeWidth={1.5} aria-hidden />
          </a>
          <IconButton label="Reload the preview" onClick={() => setManualNonce((n) => n + 1)}>
            <RotateCw size={14} strokeWidth={1.5} />
          </IconButton>
          {onClose && (
            <IconButton label="Hide the preview" onClick={onClose}>
              <X size={14} strokeWidth={1.5} />
            </IconButton>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-inset">
        {!loaded && (
          <div role="status" className="absolute inset-0 flex items-center justify-center text-small text-tertiary">
            Loading preview…
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={bustedSrc}
          src={bustedSrc}
          title="Live product preview"
          sandbox="allow-scripts"
          onLoad={() => setLoaded(true)}
          className="h-full w-full border-0 bg-white"
        />
      </div>
    </div>
  )
}
