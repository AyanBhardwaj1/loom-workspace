import { useEffect, useRef, useState } from 'react'
import type { AgentActivityStatus, SessionDetail, SessionEvent } from '@loom/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'

export interface SessionStream {
  detail: SessionDetail | null
  events: SessionEvent[]
  /** accumulated assistant_delta text since the last finalized message */
  streamingText: string
  agentStatus: AgentActivityStatus
  loading: boolean
  error: string | null
}

/**
 * The one hook behind every live session surface (main chat AND the spectator
 * sidebar): initial fetch of persisted events, live subscription, catchup on
 * reconnect, delta accumulation, dedupe by event id, ordering by seq.
 */
export function useSessionStream(sessionId: string | null): SessionStream {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [agentStatus, setAgentStatus] = useState<AgentActivityStatus>('idle')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!sessionId) {
      setDetail(null)
      setEvents([])
      setStreamingText('')
      setAgentStatus('idle')
      setLoading(false)
      setError(null)
      return
    }

    let alive = true
    lastSeqRef.current = 0
    setLoading(true)
    setError(null)
    setEvents([])
    setStreamingText('')
    setAgentStatus('idle')
    setDetail(null)

    const seen = new Set<string>()

    const ingest = (incoming: SessionEvent[]) => {
      if (!alive || incoming.length === 0) return
      // dedupe OUTSIDE the state updater — updaters must stay pure
      // (StrictMode double-invokes them, so side effects there drop events)
      const fresh = incoming.filter((e) => e.seq !== null && !seen.has(e.id))
      if (fresh.length > 0) {
        for (const e of fresh) {
          seen.add(e.id)
          if (e.seq! > lastSeqRef.current) lastSeqRef.current = e.seq!
        }
        setEvents((prev) => [...prev, ...fresh].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)))
      }
      for (const e of fresh) {
        if (e.type === 'assistant_message') setStreamingText('')
        if (e.type === 'status') {
          setAgentStatus(e.payload.status)
          if (e.payload.note === 'Session ended') {
            setDetail((prev) =>
              prev ? { ...prev, session: { ...prev.session, status: 'ended' } } : prev,
            )
          }
        }
        if (e.type === 'user_message') setAgentStatus('thinking')
      }
    }

    const offMessage = wsClient.onMessage((msg) => {
      if (msg.t === 'event' && msg.sessionId === sessionId) {
        if (msg.event.type === 'assistant_delta') {
          const chunk = msg.event.payload.text
          setStreamingText((prev) => prev + chunk)
        } else {
          ingest([msg.event])
        }
      } else if (msg.t === 'catchup_batch' && msg.sessionId === sessionId) {
        ingest(msg.events)
      }
    })
    const offOpen = wsClient.onOpen(() => {
      wsClient.catchup(sessionId, lastSeqRef.current)
    })
    const unsub = wsClient.subSession(sessionId)

    void (async () => {
      try {
        const d = await api.get<SessionDetail>(`/api/sessions/${sessionId}`)
        if (!alive) return
        setDetail(d)
        ingest(d.events)
        // events that streamed in while the fetch was in flight
        wsClient.catchup(sessionId, d.lastSeq)
        const statuses = d.events.filter((e) => e.type === 'status')
        const last = statuses[statuses.length - 1]
        if (last && last.type === 'status') setAgentStatus(last.payload.status)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load session')
      } finally {
        if (alive) setLoading(false)
      }
    })()

    return () => {
      alive = false
      offMessage()
      offOpen()
      unsub()
    }
  }, [sessionId])

  return { detail, events, streamingText, agentStatus, loading, error }
}
