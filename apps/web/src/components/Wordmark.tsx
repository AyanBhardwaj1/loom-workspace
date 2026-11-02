import { cn } from './primitives'

/**
 * The Loom wordmark — set, not drawn: condensed black Archivo, uppercase,
 * tight, with a red unit-marker square riding the cap height. Height maps to
 * the cap size so call sites keep sizing it like an image.
 */
export function Wordmark({ height = 20, className, title = 'Loom' }: { height?: number; className?: string; title?: string }) {
  return (
    <span
      role="img"
      aria-label={title}
      className={cn('font-display inline-flex select-none items-start leading-none', className)}
      style={{ fontSize: Math.round(height * 1.25) }}
    >
      <span aria-hidden>Loom</span>
      <span aria-hidden className="ml-[0.08em] mt-[0.06em] inline-block bg-signal-500" style={{ width: '0.26em', height: '0.26em' }} />
    </span>
  )
}

/** The mark alone: an ink tile with a red unit square — empty states, favicon geometry. */
export function UnitMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden>
      <rect x="0" y="0" width="32" height="32" fill="currentColor" />
      <path d="M8 6h5v15h11v5H8z" fill="var(--bg-canvas)" />
      <rect x="20" y="6" width="6" height="6" fill="var(--signal-500)" />
    </svg>
  )
}
