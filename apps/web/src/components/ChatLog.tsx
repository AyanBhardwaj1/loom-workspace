import { clsx } from 'clsx'
import { ArrowDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentActivityStatus, SessionEvent } from '@loom/shared'
import { momentAgentAwakens, momentSessionStart } from '../lib/choreography'
import { EventRow } from './EventRow'
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
  onFork?: (eventId: string) => void
  actions?: RowActions
  emptyHint?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const threadLineRef = useRef<SVGLineElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [contentH, setContentH] = useState(0)
  const items = useMemo(() => toDisplayItems(events), [events])

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
  }

  const showThinking = busy && !streaming

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

          {items.map((item, i) => (
            <EventRow
              key={itemKey(item, i)}
              item={item}
              compact={compact}
              driverName={driverName}
              driverColor={driverColor}
              animate={i >= baseline}
              onFork={onFork}
              actions={actions}
            />
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
