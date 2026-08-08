import { useRef, useState } from 'react'
import type { AgentActivityStatus } from '@loom/shared'
import { wsClient } from '../lib/ws'

export function Composer({ sessionId, agentStatus }: { sessionId: string; agentStatus: AgentActivityStatus }) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const busy = agentStatus === 'thinking' || agentStatus === 'running_tools'

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    wsClient.sendUserMessage(sessionId, trimmed)
    setText('')
    textareaRef.current?.focus()
  }

  return (
    <div className="border-t border-ink-700 bg-ink-900/80 px-5 py-3.5 backdrop-blur">
      <div className="flex items-end gap-2.5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          rows={Math.min(5, Math.max(1, text.split('\n').length))}
          placeholder={busy ? 'The agent is working — it will be ready in a moment…' : 'Tell the agent what to build next…'}
          className="input resize-none"
          disabled={false}
        />
        <button onClick={send} disabled={busy || !text.trim()} className="btn-primary shrink-0">
          {busy ? (
            <span className="thinking-dots inline-flex gap-1 px-2">
              <span />
              <span />
              <span />
            </span>
          ) : (
            'Send'
          )}
        </button>
      </div>
      <div className="mt-1.5 text-[10px] text-ink-400">
        Enter to send · Shift+Enter for a new line · every change is auto-committed to your session branch
      </div>
    </div>
  )
}
