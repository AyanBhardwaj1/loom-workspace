import { useMemo, useRef, useState } from 'react'
import type { SessionEvent } from '@loom/shared'
import { cn } from './primitives'

/**
 * 4.1 — the session as a density strip: event bursts read as ridges, with
 * glyph overlays for commits (driver dot), forks (▲), accepted suggestions
 * (◆) and handoffs. Dragging the playhead peeks the past; the log's own
 * "Jump to live" pill snaps back. Pure client-side over loaded events.
 */
export function SessionScrubber({
  events,
  driverColor,
  onPeek,
}: {
  events: SessionEvent[]
  driverColor: string
  onPeek: (seq: number) => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<{ x: number; label: string } | null>(null)
  // keyboard cursor: null = at the live edge
  const [cursor, setCursor] = useState<number | null>(null)

  const persisted = useMemo(() => events.filter((e) => e.seq !== null), [events])
  const maxSeq = persisted.length > 0 ? (persisted[persisted.length - 1]!.seq ?? 1) : 1

  // adaptive bins + a small smoothing kernel: sparse logs read as soft
  // ridges, not isolated spikes
  const BINS = Math.min(96, Math.max(24, Math.floor(persisted.length / 2)))
  const density = useMemo(() => {
    const bins = new Array<number>(BINS).fill(0)
    for (const e of persisted) {
      const i = Math.min(BINS - 1, Math.floor(((e.seq ?? 0) / maxSeq) * BINS))
      bins[i]!++
    }
    const smoothed = bins.map((_, i) => {
      let sum = 0
      let weight = 0
      for (let k = -2; k <= 2; k++) {
        const j = i + k
        if (j < 0 || j >= BINS) continue
        const w = 3 - Math.abs(k)
        sum += bins[j]! * w
        weight += w
      }
      return sum / weight
    })
    const peak = Math.max(0.001, ...smoothed)
    return smoothed.map((n) => n / peak)
  }, [persisted, maxSeq, BINS])

  const glyphs = useMemo(
    () =>
      persisted
        .map((e) => {
          const x = ((e.seq ?? 0) / maxSeq) * 100
          if (e.type === 'commit') return { x, kind: 'commit' as const, label: e.payload.plainExplanation }
          if (e.type === 'fork_marker') return { x, kind: 'fork' as const, label: `${e.payload.byUserName} forked` }
          if (e.type === 'suggestion_decision' && e.payload.decision === 'accepted')
            return { x, kind: 'suggestion' as const, label: 'suggestion accepted' }
          if (e.type === 'status' && e.payload.newDriverName)
            return { x, kind: 'handoff' as const, label: `${e.payload.newDriverName} took the wheel` }
          return null
        })
        .filter((g): g is NonNullable<typeof g> => g !== null),
    [persisted, maxSeq],
  )

  if (persisted.length < 20) return null

  const seqAtX = (clientX: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return maxSeq
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return Math.max(1, Math.round(frac * maxSeq))
  }

  // a soft ridge that sits ON a baseline (no slanted end caps): the path
  // starts and ends at the first/last bin centers, flush with the track
  const areaPath = (() => {
    const w = 100
    const h = 20
    const step = w / BINS
    const pts = density.map((v, i) => [(i + 0.5) * step, h - v * (h - 4)] as const)
    let d = `M ${pts[0]![0]} ${h}`
    for (const [x, y] of pts) d += ` L ${x} ${y}`
    d += ` L ${pts[pts.length - 1]![0]} ${h} Z`
    return d
  })()

  const position = cursor ?? maxSeq
  const step = Math.max(1, Math.round(maxSeq / 20))
  const moveTo = (seq: number) => {
    const next = Math.max(1, Math.min(maxSeq, seq))
    setCursor(next >= maxSeq ? null : next)
    onPeek(next)
  }

  return (
    <div className="border-t border-hairline px-6 py-1.5">
      <div
        ref={wrapRef}
        role="slider"
        aria-label="Session timeline — click, or use the arrow keys, to view the past"
        aria-valuemin={1}
        aria-valuemax={maxSeq}
        aria-valuenow={position}
        aria-valuetext={cursor === null ? `Live — event ${maxSeq} of ${maxSeq}` : `Event ${position} of ${maxSeq}`}
        tabIndex={0}
        className="group relative mx-auto h-6 max-w-[760px] cursor-crosshair rounded"
        onClick={(e) => moveTo(seqAtX(e.clientX))}
        onMouseMove={(e) => {
          const rect = wrapRef.current?.getBoundingClientRect()
          if (!rect) return
          const seq = seqAtX(e.clientX)
          const near = glyphs.find((g) => Math.abs((g.x / 100) * rect.width - (e.clientX - rect.left)) < 6)
          setHover({ x: e.clientX - rect.left, label: near ? near.label : `event ${seq} / ${maxSeq}` })
        }}
        onMouseLeave={() => setHover(null)}
        onKeyDown={(e) => {
          const keys: Record<string, () => void> = {
            ArrowLeft: () => moveTo(position - step),
            ArrowDown: () => moveTo(position - step),
            ArrowRight: () => moveTo(position + step),
            ArrowUp: () => moveTo(position + step),
            Home: () => moveTo(1),
            End: () => moveTo(maxSeq),
            Enter: () => moveTo(maxSeq),
          }
          const action = keys[e.key]
          if (action) {
            e.preventDefault()
            action()
          }
        }}
      >
        <svg className="absolute inset-x-0 top-0.5 h-5 w-full" preserveAspectRatio="none" viewBox="0 0 100 20" aria-hidden>
          <line x1="0" y1="20" x2="100" y2="20" stroke="var(--hairline-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <path d={areaPath} fill="var(--hairline)" stroke="var(--hairline-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
        {cursor !== null && (
          <span
            aria-hidden
            className="absolute bottom-0 top-0 w-px bg-lav-500"
            style={{ left: `${(position / maxSeq) * 100}%` }}
          />
        )}
        {glyphs.map((g, i) => (
          <span
            key={i}
            aria-hidden
            className={cn(
              'absolute top-1/2 -translate-x-1/2 -translate-y-1/2',
              g.kind === 'fork' && 'text-lav-300',
            )}
            style={{ left: `${g.x}%` }}
          >
            {g.kind === 'commit' ? (
              <span className="block h-[7px] w-[7px] rounded-full" style={{ background: driverColor }} />
            ) : g.kind === 'fork' ? (
              <span className="block h-0 w-0 border-b-[6px] border-l-[4px] border-r-[4px] border-b-current border-l-transparent border-r-transparent" />
            ) : g.kind === 'handoff' ? (
              <span className="block h-[6px] w-[6px] rotate-45 rounded-[1px] border border-lav-border bg-overlay" />
            ) : (
              <span className="block h-[6px] w-[6px] rotate-45 rounded-[1px] bg-warn" />
            )}
          </span>
        ))}
        {hover && (
          <>
            <span aria-hidden className="absolute bottom-1 top-1 w-px bg-hairline-strong" style={{ left: hover.x }} />
            <span
              className="pointer-events-none absolute bottom-full mb-1 max-w-[18rem] -translate-x-1/2 truncate whitespace-nowrap rounded border border-hairline bg-overlay px-1.5 py-0.5 font-mono text-small text-secondary shadow-dropdown"
              style={{ left: hover.x }}
            >
              {hover.label}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
