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
  checkSimilar,
  onOpenSession,
}: {
  sessionId: string
  agentStatus: AgentActivityStatus
  /** fresh session — the focus ring breathes once after the thread draws (M1) */
  fresh?: boolean
  /** C5: optimistic send (falls back to the raw socket when absent) */
  onSend?: (text: string) => boolean
  /** before a session's first task: is a teammate already doing this? */
  checkSimilar?: (text: string) => Promise<Array<{ sessionId: string; title: string; driverName: string; ask: string }>>
  onOpenSession?: (sessionId: string) => void
}) {
  const [text, setText] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [similar, setSimilar] = useState<{ text: string; matches: Array<{ sessionId: string; title: string; driverName: string; ask: string }> } | null>(null)
  const [checking, setChecking] = useState(false)
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

  // steer the running agent instead of waiting: it reads this at its next tool boundary
  const steerNow = () => {
    const trimmed = text.trim()
    if (!trimmed || !busy) return
    if (!wsClient.steer(sessionId, trimmed)) {
      setNotice('Connection lost — reconnecting. Your steer is kept; try again in a second.')
      return
    }
    setNotice(null)
    setText('')
    textareaRef.current?.focus()
  }

  // one prompt carrying a whole feature list tends to go worse than small, steerable steps
  const bigAsk = !busy && isBigAsk(text)

  const submit = async (force = false) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // starting a task: check nobody's already on it (the human decides)
    if (!busy && fresh && !force && checkSimilar && similar?.text !== trimmed) {
      setChecking(true)
      try {
        const matches = await checkSimilar(trimmed)
        if (matches.length > 0) {
          setSimilar({ text: trimmed, matches })
          return
        }
      } catch {
        /* the check is advisory — never block sending on it */
      } finally {
        setChecking(false)
      }
    }
    setSimilar(null)
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

        {similar && (
          <div role="alert" className="mb-2 border-2 border-warn bg-surface p-3">
            <div className="telemetry text-warn">Someone may already be on this</div>
            {similar.matches.map((m) => (
              <div key={m.sessionId} className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-small">
                <span className="font-semibold text-primary">{m.driverName}</span>
                <span className="min-w-0 text-secondary">is working on &ldquo;{m.ask.slice(0, 120)}&rdquo;</span>
                {onOpenSession && (
                  <button type="button" onClick={() => onOpenSession(m.sessionId)} className="telemetry text-primary underline underline-offset-2">
                    Open their session
                  </button>
                )}
              </div>
            ))}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void submit(true)}
                className="h-7 border border-hairline-strong px-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-primary hover:bg-primary hover:text-canvas"
              >
                Start anyway
              </button>
              <button type="button" onClick={() => setSimilar(null)} className="h-7 px-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-secondary hover:text-primary">
                Edit my request
              </button>
            </div>
          </div>
        )}

        <div className="relative">
          {/* M1 breathing ring */}
          <span
            ref={ringRef}
            aria-hidden
            className="pointer-events-none absolute -inset-px rounded-lg opacity-0"
            style={{ outline: '1px solid var(--signal-500)', outlineOffset: 2 }}
          />
          <div className="flex items-end gap-2 rounded-lg border border-hairline bg-raised p-2 transition-colors duration-fast focus-within:border-signal-border">
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
                  if (busy && (e.metaKey || e.ctrlKey)) steerNow()
                  else void submit()
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
            {busy && (
              <button
                onClick={steerNow}
                disabled={!text.trim()}
                title="Redirect the agent now — it reads this after the step it's on (⌘/Ctrl+Enter)"
                className={cn(
                  'flex h-7 shrink-0 items-center justify-center px-2.5 text-[11px] font-semibold uppercase tracking-[0.04em] transition-colors duration-micro',
                  text.trim() ? 'border border-hairline-strong bg-surface text-primary hover:bg-primary hover:text-canvas' : 'border border-hairline text-disabled',
                )}
              >
                Steer now
              </button>
            )}
            <button
              onClick={() => void submit()}
              disabled={!text.trim() || checking}
              className={cn(
                'flex h-7 shrink-0 items-center justify-center gap-1 rounded px-2.5 text-ui font-medium transition-colors duration-micro',
                text.trim() ? 'bg-signal-500 text-on-accent hover:bg-signal-400' : 'bg-inset text-disabled',
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
            <span>Agent is working… Enter queues for later · ⌘/Ctrl+Enter steers it now</span>
          ) : bigAsk ? (
            <span className="text-secondary">
              That’s a big ask — smaller steps are easier for the team to steer and test. Send it anyway, or split it up.
            </span>
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

/** a request bundling many things: long, or a list of four or more items */
function isBigAsk(text: string): boolean {
  const t = text.trim()
  if (t.length > 700) return true
  const items = t.split('\n').filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length
  return items >= 4
}
