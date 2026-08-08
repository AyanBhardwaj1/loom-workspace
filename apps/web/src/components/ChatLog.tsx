import { clsx } from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentActivityStatus, SessionEvent } from '@loom/shared'
import { EventRow, toDisplayItems } from './EventRow'

export function ChatLog({
  events,
  streamingText,
  agentStatus,
  driverName,
  driverColor,
  compact = false,
  onFork,
  emptyHint,
}: {
  events: SessionEvent[]
  streamingText: string
  agentStatus: AgentActivityStatus
  driverName: string
  driverColor: string
  compact?: boolean
  onFork?: (eventId: string) => void
  emptyHint?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const items = useMemo(() => toDisplayItems(events), [events])

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
        {items.map((item, i) => (
          <EventRow
            key={itemKey(item, i)}
            item={item}
            compact={compact}
            driverName={driverName}
            driverColor={driverColor}
            onFork={onFork}
          />
        ))}
        {streamingText && (
          <div
            className={clsx(
              'streaming-caret whitespace-pre-wrap leading-relaxed text-ink-100',
              compact ? 'text-xs' : 'text-sm',
            )}
          >
            {streamingText}
          </div>
        )}
        {showThinking && (
          <div className="my-2 flex items-center gap-2 text-xs text-ink-400">
            <span className="thinking-dots inline-flex gap-1">
              <span />
              <span />
              <span />
            </span>
            agent is {agentStatus === 'thinking' ? 'thinking' : 'working'}…
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          onClick={() => {
            setAtBottom(true)
            scrollToBottom('smooth')
          }}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-ink-500 bg-ink-800/95 px-3 py-1 text-[11px] text-ink-200 shadow-lg backdrop-blur hover:border-accent"
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
