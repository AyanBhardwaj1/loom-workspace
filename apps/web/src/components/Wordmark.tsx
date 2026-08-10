/**
 * The Loom wordmark — custom-drawn lettering, not typeset text (Part VI).
 *
 * Monoline lowercase "loom" on Geist's 600-weight optical skeleton. The two
 * o's interlock like chain links: the first o's stroke passes OVER at the
 * upper crossing and UNDER at the lower one — rendered by breaking each
 * circle with a gap where the other passes in front. Two threads, woven.
 * The l and final m terminals carry a small angled cut, like a clipped
 * thread end. Geometry is exact (see the derivation script in git history);
 * gaps are generous (±19°) so the weave reads at the 20px header height.
 */
export function Wordmark({ height = 20, className, title = 'Loom' }: { height?: number; className?: string; title?: string }) {
  return (
    <svg
      viewBox="-2 -4 227 110"
      height={height}
      className={className}
      role="img"
      aria-label={title}
      fill="none"
    >
      {/* l — stem + angled-cut top terminal */}
      <path d="M 8 8 L 8 100" stroke="currentColor" strokeWidth="13" />
      <path d="M 1.5 8.5 L 1.5 4.5 L 14.5 0 L 14.5 8.5 Z" fill="currentColor" />
      {/* first o — gap at the LOWER crossing (it passes under there) */}
      <path d="M 78.05 88.42 A 29.5 29.5 0 1 1 89.58 73.05" stroke="currentColor" strokeWidth="13" />
      {/* second o — gap at the UPPER crossing (the first o passes over) */}
      <path d="M 92.15 39.58 A 29.5 29.5 0 1 1 80.62 54.95" stroke="currentColor" strokeWidth="13" />
      {/* m — stem + two arches; final leg ends in the angled cut */}
      <path d="M 162.2 100 L 162.2 41.5 A 13.5 13.5 0 0 1 189.2 41.5 L 189.2 100" stroke="currentColor" strokeWidth="13" />
      <path d="M 189.2 41.5 A 13.5 13.5 0 0 1 216.2 41.5 L 216.2 94" stroke="currentColor" strokeWidth="13" />
      <path d="M 209.7 93.5 L 222.7 93.5 L 222.7 95.5 L 209.7 100 Z" fill="currentColor" />
    </svg>
  )
}

/** The interlocked oo alone — favicon geometry, reusable inline (empty states). */
export function WovenMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="11 -10 148 148" width={size} height={size} className={className} aria-hidden fill="none">
      <path d="M 78.05 88.42 A 29.5 29.5 0 1 1 89.58 73.05" stroke="currentColor" strokeWidth="14" />
      <path d="M 92.15 39.58 A 29.5 29.5 0 1 1 80.62 54.95" stroke="currentColor" strokeWidth="14" />
    </svg>
  )
}
