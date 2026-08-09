import { useEffect, useRef, useState } from 'react'
import type { AgentActivityStatus } from '@loom/shared'
import { wsClient } from '../lib/ws'

export function Composer({ sessionId, agentStatus }: { sessionId: string; agentStatus: AgentActivityStatus }) {
  const [text, setText] = useState('')
  const [queue, setQueue] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const busy = agentStatus === 'thinking' || agentStatus === 'running_tools'
  const prevBusy = useRef(busy)

  // switching sessions starts fresh
  useEffect(() => {
    setQueue([])
    setText('')
    setNotice(null)
    prevBusy.current = false
  }, [sessionId])

  // dispatch exactly one queued message on each busy → idle transition
  useEffect(() => {
    if (prevBusy.current && !busy && queue.length > 0) {
      const [next, ...rest] = queue
      if (wsClient.sendUserMessage(sessionId, next!)) setQueue(rest)
    }
    prevBusy.current = busy
  }, [busy, queue, sessionId])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (busy) {
      // agent is working — queue it; it dispatches when the turn ends
      setQueue((q) => [...q, trimmed])
      setText('')
      textareaRef.current?.focus()
      return
    }
    const sent = wsClient.sendUserMessage(sessionId, trimmed)
    if (!sent) {
      setNotice('Connection lost — reconnecting. Your message is kept, try again in a second.')
      return
    }
    setNotice(null)
    setText('')
    textareaRef.current?.focus()
  }

  return (
    <div className="border-t border-white/[0.07] bg-ink-950/70 px-5 py-3.5 backdrop-blur-xl">
      {queue.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="micro-label">queued</span>
          {queue.map((q, i) => (
            <span
              key={i}
              className="chip animate-rise-in max-w-[16rem] gap-1 border-thread-suggest/30 bg-thread-suggest/[0.08] text-[11px] text-thread-suggest"
            >
              <span className="truncate">⏳ {q}</span>
              <button
                onClick={() => setQueue((qq) => qq.filter((_, j) => j !== i))}
                className="text-thread-suggest/60 hover:text-thread-suggest"
                title="Remove from queue"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2.5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          rows={Math.min(5, Math.max(1, text.split('\n').length))}
          placeholder={busy ? 'Agent is working — type to queue your next message…' : 'Tell the agent what to build next…'}
          className="input resize-none"
        />
        {busy && (
          <button
            onClick={() => wsClient.stop(sessionId)}
            className="btn shrink-0 border border-thread-del/40 bg-thread-del/10 px-4 py-2 text-sm text-thread-del transition-all hover:-translate-y-px hover:bg-thread-del/15 hover:shadow-[0_0_20px_-4px_rgba(242,109,109,0.5)]"
            title="Stop the agent — partial work is still committed"
          >
            ⏹ Stop
          </button>
        )}
        <button onClick={submit} disabled={!text.trim()} className="btn-primary shrink-0">
          {busy ? '＋ Queue' : 'Send'}
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-ink-400">
        {notice ? (
          <span className="text-amber-300">{notice}</span>
        ) : queue.length > 0 ? (
          <span className="text-ink-300">
            {queue.length} message{queue.length === 1 ? '' : 's'} queued — each sends when the agent is free
          </span>
        ) : (
          'Enter to send · Shift+Enter for a new line · every change is auto-committed to your session branch'
        )}
      </div>
    </div>
  )
}
