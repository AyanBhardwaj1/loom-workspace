import { useEffect, useMemo, useRef, useState } from 'react'

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
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const bustedSrc = useMemo(() => {
    const sep = src.includes('?') ? '&' : '?'
    return `${src}${sep}_v=${reloadKey}-${manualNonce}`
  }, [src, reloadKey, manualNonce])

  // brief "updated" flash when a new commit reloads the preview
  const [flash, setFlash] = useState(false)
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 1200)
    return () => clearTimeout(t)
  }, [reloadKey])

  return (
    <div className="flex h-full min-w-0 flex-col border-l border-ink-700 bg-white/[0.02]">
      <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-ink-300">▶ Preview</span>
        {label && <span className="truncate text-[11px] text-ink-400">{label}</span>}
        {flash && (
          <span className="animate-highlight rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">
            updated
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            title="Open the preview in a new tab"
            className="btn-ghost px-2 py-1 text-xs"
          >
            ↗
          </a>
          <button
            onClick={() => setManualNonce((n) => n + 1)}
            title="Reload the preview"
            className="btn-ghost px-2 py-1 text-xs"
          >
            ⟳
          </button>
          {onClose && (
            <button onClick={onClose} title="Hide the preview" className="btn-ghost px-2 py-1 text-xs">
              ✕
            </button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {loadedAt === null && (
          <div className="absolute inset-0 flex items-center justify-center bg-ink-900 text-xs text-ink-400">
            Loading preview…
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={bustedSrc}
          src={bustedSrc}
          title="Live product preview"
          sandbox="allow-scripts"
          onLoad={() => setLoadedAt(Date.now())}
          className="h-full w-full border-0"
        />
      </div>
    </div>
  )
}
