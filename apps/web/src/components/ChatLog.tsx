import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentActivityStatus, SessionEvent } from '@loom/shared'
import { EventRow, toDisplayItems, type RowActions } from './EventRow'

export function ChatLog({
  events,
  streamingText,
  agentStatus,
  driverName,
  driverColor,
  compact = false,
  onFork,
  actions,
  emptyHint,
}: {
  events: SessionEvent[]
  streamingText: string
  agentStatus: AgentActivityStatus
  driverName: string
  driverColor: string
  compact?: boolean
  onFork?: (eventId: string) => void
  actions?: RowActions
  emptyHint?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const items = useMemo(() => toDisplayItems(events), [events])
  // only animate rows that arrive AFTER the initial load, so opening a long
  // session doesn't flash hundreds of entrance animations at once
  const baselineRef = useRef<number | null>(null)
  if (baselineRef.current === null && items.length > 0) baselineRef.current = items.length
  const baseline = baselineRef.current ?? 0
  const active = agentStatus === 'thinking' || agentStatus === 'running_tools'

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

  const showThinking =
    (agentStatus === 'thinking' || agentStatus === 'running_tools') && streamingText.length === 0

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        onScroll={onScroll}
        className={clsx('min-h-0 flex-1 overflow-y-auto', compact ? 'px-3 py-2' : 'px-5 py-4')}
      >
        {items.length === 0 && !streamingText && !showThinking && (
          <div className="flex h-full items-center justify-center text-center text-xs text-ink-400">
            {emptyHint ?? 'No activity yet.'}
          </div>
        )}
        {/* the thread: a faint continuous filament behind the per-row glow-edges */}
        {items.length > 0 && (
          <div className="pointer-events-none absolute bottom-3 top-4" style={{ left: compact ? 6 : 10 }}>
            <div
              className="h-full w-px"
              style={{
                background:
                  'linear-gradient(to bottom, transparent, rgba(139,124,246,0.22) 8%, rgba(56,214,224,0.14), transparent)',
              }}
            />
            {active && (
              <span
                className="absolute -left-[3px] bottom-0 h-1.5 w-1.5 animate-node-pulse rounded-full"
                style={{ background: 'var(--thread-agent)', boxShadow: '0 0 8px 0 var(--thread-agent)' }}
              />
            )}
          </div>
        )}
        {items.map((item, i) => (
          <div key={itemKey(item, i)} className={i >= baseline ? 'animate-rise-in' : undefined}>
            <EventRow
              item={item}
              compact={compact}
              driverName={driverName}
              driverColor={driverColor}
              onFork={onFork}
              actions={actions}
            />
          </div>
        ))}
        {streamingText && (
          <div
            className="glow-edge my-0.5 py-0.5 pl-3.5"
            style={{ ['--edge' as string]: 'var(--thread-agent)' }}
          >
            <div
              className={clsx(
                'streaming-caret whitespace-pre-wrap leading-relaxed text-ink-100',
                compact ? 'text-xs' : 'text-sm',
              )}
            >
              {streamingText}
            </div>
          </div>
        )}
        {showThinking && (
          <div className="my-2 flex items-center gap-2.5 pl-3.5 text-xs text-ink-400">
            <span className="thinking-dots">
              <span />
              <span />
              <span />
            </span>
            <span className="micro-label">agent is {agentStatus === 'thinking' ? 'thinking' : 'working'}</span>
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          onClick={() => {
            setAtBottom(true)
            scrollToBottom('smooth')
          }}
          className="animate-fade-in-up absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-accent/40 bg-ink-900/90 px-3 py-1 text-[11px] text-ink-100 shadow-glass backdrop-blur-md transition-colors hover:border-accent hover:bg-ink-800"
        >
          ↓ jump to latest
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
