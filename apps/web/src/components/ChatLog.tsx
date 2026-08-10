import { useVirtualizer } from '@tanstack/react-virtual'
import { clsx } from 'clsx'
import { ArrowDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentActivityStatus, PresenceUser, SessionEvent, SessionEventOf } from '@loom/shared'
import { momentAgentAwakens, momentSessionStart } from '../lib/choreography'
import { buildEvolutions } from '../lib/diff'
import { wsClient } from '../lib/ws'
import type { PendingMessage } from '../state/useSessionStream'
import { lazy, Suspense } from 'react'
import { EventRow } from './EventRow'
import { Modal } from './overlay'

// C12 — magic-move (and its shiki machinery) loads only when a player opens
const EvolutionPlayer = lazy(() => import('./EvolutionPlayer').then((m) => ({ default: m.EvolutionPlayer })))
import { toDisplayItems, type RowActions } from './eventStream'
import { eventGist } from '@loom/shared'
import { useReactions } from './Reactions'
import { Avatar } from './primitives'

/**
 * The event log — every event sits on the thread. The thread is a real SVG
 * line in a 24px left gutter: at-rest whisper alpha, a lavender current only
 * while the agent streams (CSS .thread-current), a hollow terminal node when
 * the session has ended.
 */
export function ChatLog({
  events,
  streamingText,
  agentStatus,
  driverName,
  driverColor,
  ended = false,
  compact = false,
  freshSession = false,
  onFork,
  actions,
  emptyHint,
  reportReadingFor = null,
  readers,
  pending,
  onRetryPending,
  onDiscardPending,
  testId,
  onReact,
  jumpToSeq,
  onJumped,
}: {
  events: SessionEvent[]
  streamingText: string
  agentStatus: AgentActivityStatus
  driverName: string
  driverColor: string
  /** session has ended — the thread terminates in a hollow node */
  ended?: boolean
  compact?: boolean
  /** brand-new session (M1 plays the thread draw once) */
  freshSession?: boolean
  onFork?: (eventId: string, anchorEl: HTMLElement | null) => void
  actions?: RowActions
  emptyHint?: string
  /** F5: report this viewer's read position (session id enables it) */
  reportReadingFor?: string | null
  /** F5: other viewers' read positions, docked to the thread */
  readers?: PresenceUser[]
  /** C5: optimistic user messages (pending spinner / failed retry) */
  pending?: PendingMessage[]
  onRetryPending?: (localId: string) => void
  onDiscardPending?: (localId: string) => void
  /** stable hook for tests to scope this specific log */
  testId?: string
  /** 1.2: spectators can rain reactions (driver just watches them) */
  onReact?: (emoji: string, atSeq: number | null) => void
  /** 4.1/8.2: scroll to a seq (scrubber peek / #seq-N deep links) */
  jumpToSeq?: number | null
  onJumped?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const threadLineRef = useRef<SVGLineElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [contentH, setContentH] = useState(0)
  const items = useMemo(() => toDisplayItems(events), [events])
  // F4: per-path successive contents (only paths touched more than once)
  const evolutions = useMemo(() => (compact ? null : buildEvolutions(events)), [events, compact])
  // F4: the player lives at the log root — virtualized rows recycle away
  const [evo, setEvo] = useState<{ path: string; steps: string[] } | null>(null)
  const rowActions = useMemo<RowActions | undefined>(
    () => ({ ...(actions ?? {}), onPlayEvolution: (path: string, steps: string[]) => setEvo({ path, steps }) }),
    [actions],
  )

  // 1.2 — transient reaction rain + page-lifetime counters
  const reactionSessionId = events.length > 0 ? events[0]!.sessionId : null
  const { floats, counts } = useReactions(compact ? null : reactionSessionId)

  // only animate rows that arrive AFTER the initial load
  const baselineRef = useRef<number | null>(null)
  if (baselineRef.current === null && items.length > 0) baselineRef.current = items.length
  const baseline = baselineRef.current ?? 0

  const busy = agentStatus === 'thinking' || agentStatus === 'running_tools'
  const streaming = streamingText.length > 0

  // thread height follows content (works untouched under virtualization later)
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setContentH(el.scrollHeight))
    ro.observe(el)
    setContentH(el.scrollHeight)
    return () => ro.disconnect()
  }, [])

  // M1 — fresh session: the thread draws itself in
  const m1Played = useRef(false)
  useEffect(() => {
    if (!freshSession || m1Played.current || compact) return
    if (threadLineRef.current) {
      m1Played.current = true
      momentSessionStart(threadLineRef.current)
    }
  }, [freshSession, compact])

  // M2 — first delta of a turn: one pulse travels the thread
  const wasStreaming = useRef(false)
  useEffect(() => {
    if (streaming && !wasStreaming.current && !compact && gutterRef.current) {
      momentAgentAwakens(gutterRef.current, Math.min(contentH, containerRef.current?.clientHeight ?? 600))
    }
    wasStreaming.current = streaming
  }, [streaming, compact, contentH])

  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = containerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }

  useEffect(() => {
    if (atBottom) scrollToBottom()
  }, [items.length, streamingText, agentStatus, atBottom])

  useEffect(() => {
    scrollToBottom()
  }, [])

  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 90)
    reportReading()
  }

  // F5 — report the read position (bottom-most visible event), throttled ≥1s
  const lastReport = useRef<{ at: number; eventId: string | null }>({ at: 0, eventId: null })
  const reportTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reportReading = () => {
    if (!reportReadingFor) return
    if (reportTimer.current) return
    reportTimer.current = setTimeout(() => {
      reportTimer.current = null
      const container = containerRef.current
      if (!container) return
      const bottom = container.getBoundingClientRect().bottom
      let current: string | null = null
      for (const row of container.querySelectorAll<HTMLElement>('[data-event-id]')) {
        if (row.getBoundingClientRect().top < bottom - 24) current = row.dataset.eventId ?? null
        else break
      }
      if (current !== lastReport.current.eventId) {
        lastReport.current = { at: Date.now(), eventId: current }
        wsClient.setReading(reportReadingFor, current)
      }
    }, 1000)
  }
  useEffect(() => {
    return () => {
      if (reportTimer.current) clearTimeout(reportTimer.current)
    }
  }, [])

  // F8 — annotations grouped under their target events
  const annotationsByTarget = useMemo(() => {
    const map = new Map<string, Array<SessionEventOf<'annotation'>>>()
    for (const e of events) {
      if (e.type !== 'annotation') continue
      const list = map.get(e.payload.targetEventId) ?? []
      list.push(e)
      map.set(e.payload.targetEventId, list)
    }
    return map.size > 0 ? map : null
  }, [events])

  // F5 — other viewers' read positions, grouped per event
  const readersByEvent = useMemo(() => {
    if (!readers || readers.length === 0) return null
    const map = new Map<string, PresenceUser[]>()
    for (const r of readers) {
      if (!r.readingEventId) continue
      const list = map.get(r.readingEventId) ?? []
      list.push(r)
      map.set(r.readingEventId, list)
    }
    return map.size > 0 ? map : null
  }, [readers])

  const showThinking = busy && !streaming

  // C8 — screen readers hear new activity at a calm cadence (≤1 per 4s)
  const [announcement, setAnnouncement] = useState('')
  const lastAnnounce = useRef(0)
  useEffect(() => {
    if (events.length === 0) return
    const now = Date.now()
    if (now - lastAnnounce.current < 4000) return
    lastAnnounce.current = now
    const last = events[events.length - 1]!
    setAnnouncement(eventGist(last))
  }, [events])

  /**
   * C1 — virtualization: only visible rows render; dynamic measurement keeps
   * variable-height rows honest; generous overscan so the thread and its
   * nodes never visibly gap while scrolling. Bottom anchoring is preserved:
   * the atBottom effect scrolls the raw container, which the virtualizer
   * observes. A 10k-event log renders ~30 rows.
   */
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 72,
    overscan: 14,
    getItemKey: (i) => itemKey(items[i]!, i),
  })
  const virtualItems = virtualizer.getVirtualItems()

  // 4.1/8.2 — jump to a seq (scrubber peek or a #seq-N deep link) + flash it
  const [flashSeq, setFlashSeq] = useState<number | null>(null)
  useEffect(() => {
    if (jumpToSeq == null) return
    const idx = items.findIndex((it) => {
      const seq = it.kind === 'tool' ? it.call.seq : it.event.seq
      return seq !== null && seq >= jumpToSeq
    })
    if (idx >= 0) {
      setAtBottom(false)
      virtualizer.scrollToIndex(idx, { align: 'center' })
      setFlashSeq(jumpToSeq)
      const t = setTimeout(() => setFlashSeq(null), 2000)
      onJumped?.()
      return () => clearTimeout(t)
    }
    onJumped?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToSeq])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-testid={testId}>
      <span aria-live="polite" role="status" className="sr-only">
        {announcement}
      </span>
      <div ref={containerRef} onScroll={onScroll} className={clsx('min-h-0 flex-1 overflow-y-auto', compact ? 'px-3 py-2' : 'px-6 py-4')}>
        <div ref={contentRef} className={clsx('relative mx-auto', !compact && 'max-w-[760px]')}>
          {items.length === 0 && !streaming && !showThinking && (
            <div className="flex h-full items-center justify-center py-16 text-center text-small text-tertiary">
              {emptyHint ?? 'Send the first message to start building.'}
            </div>
          )}

          {/* the thread */}
          {!compact && (items.length > 0 || streaming || showThinking) && (
            <div ref={gutterRef} className="pointer-events-none absolute bottom-1 left-[7.5px] top-1 w-px" aria-hidden>
              <svg className="h-full w-[3px] overflow-visible" preserveAspectRatio="none">
                <line ref={threadLineRef} x1="0.5" y1="0" x2="0.5" y2={Math.max(contentH - 8, 0)} stroke="var(--thread-rest)" strokeWidth="1.5" />
                {busy && (
                  <line
                    x1="0.5"
                    y1="0"
                    x2="0.5"
                    y2={Math.max(contentH - 8, 0)}
                    strokeWidth="1.5"
                    className="thread-current"
                  />
                )}
              </svg>
              {ended && (
                <span
                  className="absolute -left-[3.5px] h-2 w-2 rounded-full border bg-canvas"
                  style={{ top: Math.max(contentH - 10, 0), borderColor: 'var(--thread-node)' }}
                />
              )}
            </div>
          )}

          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((vi) => {
              const item = items[vi.index]!
              const eventId = itemKey(item, vi.index)
              const seq = item.kind === 'tool' ? item.call.seq : item.event.seq
              return (
                <div
                  key={vi.key}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  className={clsx('absolute left-0 top-0 w-full', flashSeq !== null && seq === flashSeq && 'animate-highlight rounded')}
                  style={{ transform: `translateY(${vi.start}px)` }}
                >
                  <EventRow
                    item={item}
                    compact={compact}
                    driverName={driverName}
                    driverColor={driverColor}
                    animate={vi.index >= baseline}
                    onFork={onFork}
                    actions={rowActions}
                    evolutions={evolutions}
                    readers={readersByEvent?.get(eventId)}
                    annotations={annotationsByTarget?.get(eventId)}
                    onReact={onReact}
                    reactionCounts={seq !== null ? counts.get(seq) : undefined}
                  />
                </div>
              )
            })}
          </div>

          {/* C5 — optimistic echoes: pending spinner, failed → retry/discard */}
          {pending?.map((p) => (
            <div key={p.localId} className={clsx('animate-rise', compact ? 'py-1' : 'py-2 pl-6 pr-8')}>
              <div
                className={clsx(
                  'max-w-[85%] rounded-lg border px-3.5 py-2.5',
                  p.failed ? 'border-danger-border bg-raised' : 'border-hairline bg-raised',
                )}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-small font-medium text-secondary">{driverName}</span>
                  <span className="ml-auto inline-flex items-center">
                    {p.failed ? (
                      <span className="text-small text-danger">not sent</span>
                    ) : (
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border border-hairline-strong border-t-lav-500" style={{ animationDuration: '0.8s' }} />
                    )}
                  </span>
                </div>
                <div className={clsx('whitespace-pre-wrap text-primary', compact ? 'text-small' : 'text-body')}>{p.text}</div>
                {p.failed && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => onRetryPending?.(p.localId)}
                      className="rounded border border-hairline px-2 py-0.5 text-small text-secondary transition-colors duration-micro hover:border-hairline-hover hover:text-primary"
                    >
                      Retry
                    </button>
                    <button
                      onClick={() => onDiscardPending?.(p.localId)}
                      className="rounded px-2 py-0.5 text-small text-tertiary transition-colors duration-micro hover:text-secondary"
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* streaming: min-heights reserved before content lands — zero CLS */}
          {(streaming || showThinking) && (
            <div className={clsx('min-h-[24px]', compact ? 'py-1' : 'py-2 pl-6 pr-8')}>
              {streaming ? (
                <div className={clsx('stream-caret max-w-[70ch] whitespace-pre-wrap text-primary', compact ? 'text-small' : 'text-body')}>
                  {streamingText}
                </div>
              ) : (
                <div className="flex min-h-[24px] items-center gap-2 text-small text-tertiary">
                  <span className="stream-caret" />
                  <span>{agentStatus === 'thinking' ? 'thinking' : 'working'}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 1.2 — the rain: floats anchored to their rows, or the bottom-right live edge */}
      {!compact && floats.length > 0 && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-sticky overflow-hidden">
          {floats.map((f) => {
            const row =
              f.atSeq !== null
                ? (containerRef.current?.querySelector(`[data-seq="${f.atSeq}"]`) as HTMLElement | null)
                : null
            const cRect = containerRef.current?.getBoundingClientRect()
            const rRect = row?.getBoundingClientRect()
            const anchored = rRect && cRect && rRect.bottom > cRect.top && rRect.top < cRect.bottom
            const left = anchored ? rRect.left - cRect.left + Math.min(rRect.width - 60, 340) : undefined
            const top = anchored ? rRect.top - cRect.top + rRect.height / 2 : undefined
            return (
              <span
                key={f.id}
                className="reaction-float absolute"
                style={
                  anchored
                    ? { left, top, ['--drift' as string]: `${f.drift * 28}px` }
                    : { right: 48, bottom: 84, ['--drift' as string]: `${f.drift * 28}px` }
                }
              >
                <span className="text-[20px] leading-none">{f.emoji}</span>
                <span className="reaction-name block text-center text-[10px]" style={{ color: f.byColor }}>
                  {f.byName}
                </span>
              </span>
            )
          })}
        </div>
      )}

      {/* 1.1 — spectators at the live edge cluster in a quiet pill */}
      {!compact && readers && readers.filter((r) => !r.readingEventId).length > 0 && (
        <div className="absolute bottom-3 left-6 z-sticky flex items-center gap-1.5 rounded-full border border-hairline bg-overlay py-0.5 pl-1 pr-2 shadow-dropdown">
          <span className="flex -space-x-1">
            {readers
              .filter((r) => !r.readingEventId)
              .slice(0, 4)
              .map((r) => (
                <span key={r.userId} className="rounded-full ring-1 ring-overlay">
                  <Avatar name={r.name} color={r.avatarColor} size="xs" title={`${r.name} — watching live`} />
                </span>
              ))}
          </span>
          <span className="inline-flex items-center gap-1 text-micro uppercase tracking-[0.08em] text-tertiary">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-lav-500" />
            live
          </span>
        </div>
      )}

      {evo && (
        <Modal open onClose={() => setEvo(null)} title={`Evolution — ${evo.path}`} width={780}>
          <div className="-m-1 overflow-hidden rounded-lg border border-hairline">
            <Suspense
              fallback={
                <div className="flex justify-center py-10">
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border border-hairline-strong border-t-lav-500" style={{ animationDuration: '0.8s' }} />
                </div>
              }
            >
              <EvolutionPlayer path={evo.path} contents={evo.steps} onClose={() => setEvo(null)} />
            </Suspense>
          </div>
        </Modal>
      )}

      {!atBottom && (
        <button
          onClick={() => {
            setAtBottom(true)
            scrollToBottom('smooth')
          }}
          className="absolute bottom-3 left-1/2 z-sticky flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline bg-overlay px-3 py-1 text-micro uppercase tracking-[0.08em] text-secondary shadow-dropdown transition-colors duration-micro hover:text-primary"
        >
          <ArrowDown size={12} strokeWidth={1.5} />
          Jump to live
        </button>
      )}
    </div>
  )
}

function itemKey(item: ReturnType<typeof toDisplayItems>[number], index: number): string {
  switch (item.kind) {
    case 'tool':
      return item.call.id
    default:
      return 'event' in item ? item.event.id : String(index)
  }
}
