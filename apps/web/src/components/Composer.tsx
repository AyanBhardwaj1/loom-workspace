import { clsx } from 'clsx'
import { ArrowUp, Square, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AgentActivityStatus } from '@loom/shared'
import { momentComposerBreathe } from '../lib/choreography'
import { Spinner, cn } from './primitives'
import { wsClient } from '../lib/ws'

export function Composer({
  sessionId,
  agentStatus,
  fresh = false,
  onSend,
}: {
  sessionId: string
  agentStatus: AgentActivityStatus
  /** fresh session — the focus ring breathes once after the thread draws (M1) */
  fresh?: boolean
  /** C5: optimistic send (falls back to the raw socket when absent) */
  onSend?: (text: string) => boolean
}) {
  const [text, setText] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const ringRef = useRef<HTMLSpanElement>(null)
  const busy = agentStatus === 'thinking' || agentStatus === 'running_tools'
  const prevBusy = useRef(busy)

  // switching sessions starts fresh
  useEffect(() => {
    setQueue([])
    setText('')
    setNotice(null)
    prevBusy.current = false
  }, [sessionId])

  // M1 companion: the ring breathes once as the thread finishes drawing
  useEffect(() => {
    if (fresh && ringRef.current) {
      const t = setTimeout(() => ringRef.current && momentComposerBreathe(ringRef.current), 380)
      return () => clearTimeout(t)
    }
  }, [fresh])

  const send = (t: string): boolean => (onSend ? onSend(t) : wsClient.sendUserMessage(sessionId, t))

  // dispatch exactly one queued message on each busy → idle transition
  useEffect(() => {
    if (prevBusy.current && !busy && queue.length > 0) {
      const [next, ...rest] = queue
      if (send(next!)) setQueue(rest)
    }
    prevBusy.current = busy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, queue, sessionId])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (busy) {
      setQueue((q) => [...q, trimmed])
      setText('')
      textareaRef.current?.focus()
      return
    }
    const sent = send(trimmed)
    if (!sent && !onSend) {
      // raw-socket path: keep the text so nothing is lost
      setNotice('Connection lost — reconnecting. Your message is kept; try again in a second.')
      return
    }
    setNotice(null)
    setText('')
    textareaRef.current?.focus()
  }

  return (
    <div className="border-t border-hairline px-6 py-3.5">
      <div className="mx-auto max-w-[760px]">
        {queue.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-small font-medium text-tertiary">Queued</span>
            {queue.map((q, i) => (
              <span
                key={i}
                className="inline-flex h-6 max-w-[16rem] items-center gap-1.5 rounded-full border border-warn-border px-2.5 text-small text-warn"
              >
                <span className="truncate">{q}</span>
                <button
                  onClick={() => setQueue((qq) => qq.filter((_, j) => j !== i))}
                  className="text-warn transition-opacity duration-micro hover:opacity-70"
                  title="Remove from queue"
                  aria-label={`Remove “${q.slice(0, 40)}” from the queue`}
                >
                  <X size={11} strokeWidth={2} aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          {/* M1 breathing ring */}
          <span
            ref={ringRef}
            aria-hidden
            className="pointer-events-none absolute -inset-px rounded-lg opacity-0"
            style={{ outline: '1px solid var(--lav-500)', outlineOffset: 2 }}
          />
          <div className="flex items-end gap-2 rounded-lg border border-hairline bg-raised p-2 transition-colors duration-fast focus-within:border-lav-border">
            <textarea
              ref={textareaRef}
              name="message"
              aria-label="Message the agent"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter confirms an IME composition (CJK input) — it must not send
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={Math.min(5, Math.max(1, text.split('\n').length))}
              placeholder={busy ? 'Agent is working — type to queue your next message…' : 'Tell the agent what to build next…'}
              className="min-h-[28px] w-full resize-none bg-transparent px-1.5 py-1 text-body text-primary outline-none placeholder:text-tertiary"
            />
            {busy && (
              <button
                onClick={() => wsClient.stop(sessionId)}
                title="Stop the agent — partial work is still committed"
                aria-label="Stop the agent"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-hairline text-secondary transition-colors duration-micro hover:border-danger-border hover:text-danger"
              >
                <Square size={12} strokeWidth={2} fill="currentColor" aria-hidden />
              </button>
            )}
            <button
              onClick={submit}
              disabled={!text.trim()}
              className={cn(
                'flex h-7 shrink-0 items-center justify-center gap-1 rounded px-2.5 text-ui font-medium transition-colors duration-micro',
                text.trim() ? 'bg-lav-500 text-on-accent hover:bg-lav-400' : 'bg-inset text-disabled',
              )}
            >
              {busy ? 'Queue' : 'Send'}
              {!busy && <ArrowUp size={13} strokeWidth={2} aria-hidden />}
            </button>
          </div>
        </div>

        <div
          aria-live="polite"
          className={clsx('mt-1.5 flex min-h-[18px] items-center gap-2 text-small', notice ? 'text-warn' : 'text-tertiary')}
        >
          {busy && <Spinner className="h-3 w-3" />}
          {notice ? (
            <span>{notice}</span>
          ) : busy ? (
            <span>Agent is working…</span>
          ) : queue.length > 0 ? (
            <span className="tnum">
              {queue.length} message{queue.length === 1 ? '' : 's'} queued — each sends when the agent is free
            </span>
          ) : (
            <span>
              Enter to send · Shift+Enter for a new line · every change auto-commits to your session branch
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
