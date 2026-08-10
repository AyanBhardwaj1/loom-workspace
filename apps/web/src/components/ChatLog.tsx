import { useVirtualizer } from '@tanstack/react-virtual'
import { clsx } from 'clsx'
import { ArrowDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentActivityStatus, PresenceUser, SessionEvent } from '@loom/shared'
import { momentAgentAwakens, momentSessionStart } from '../lib/choreography'
import { buildEvolutions } from '../lib/diff'
import { wsClient } from '../lib/ws'
import type { PendingMessage } from '../state/useSessionStream'
import { EventRow } from './EventRow'
import { EvolutionPlayer } from './EvolutionPlayer'
import { Modal } from './overlay'
import { toDisplayItems, type RowActions } from './eventStream'

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

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
              return (
                <div
                  key={vi.key}
                  ref={virtualizer.measureElement}
                  data-index={vi.index}
                  className="absolute left-0 top-0 w-full"
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

      {evo && (
        <Modal open onClose={() => setEvo(null)} title={`Evolution — ${evo.path}`} width={780}>
          <div className="-m-1 overflow-hidden rounded-lg border border-hairline">
            <EvolutionPlayer path={evo.path} contents={evo.steps} onClose={() => setEvo(null)} />
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
