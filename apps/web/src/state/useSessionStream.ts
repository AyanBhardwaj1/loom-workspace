import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentActivityStatus, SessionDetail, SessionEvent } from '@loom/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'

/** C5 — a locally-echoed user message awaiting its server-persisted twin. */
export interface PendingMessage {
  localId: string
  text: string
  at: string
  failed: boolean
}

export interface SessionStream {
  detail: SessionDetail | null
  events: SessionEvent[]
  /** accumulated assistant_delta text since the last finalized message */
  streamingText: string
  agentStatus: AgentActivityStatus
  loading: boolean
  error: string | null
  /** C5: optimistic user messages not yet confirmed by seq */
  pending: PendingMessage[]
  /** C5: send with local echo; false = socket down AND echo marked failed */
  sendMessage: (text: string) => boolean
  retryPending: (localId: string) => void
  discardPending: (localId: string) => void
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
  const [pending, setPending] = useState<PendingMessage[]>([])
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
          // F9 — a handoff status carries the new driver; every viewer's
          // detail (and therefore composer ownership) flips at the seam
          if (e.payload.newDriverUserId) {
            const { newDriverUserId, newDriverName, newDriverColor } = e.payload
            setDetail((prev) =>
              prev
                ? {
                    ...prev,
                    session: {
                      ...prev.session,
                      driverUserId: newDriverUserId,
                      driverName: newDriverName ?? prev.session.driverName,
                      driverAvatarColor: newDriverColor ?? prev.session.driverAvatarColor,
                    },
                  }
                : prev,
            )
          }
        }
        if (e.type === 'user_message') {
          setAgentStatus('thinking')
          // C5 — reconcile: the persisted twin replaces the local echo
          const text = e.payload.text
          setPending((prev) => {
            const idx = prev.findIndex((p) => p.text === text)
            return idx >= 0 ? prev.filter((_, i) => i !== idx) : prev
          })
        }
      }
    }

    // C2 — delta coalescing: token storms flush once per animation frame
    // (one re-render per frame, not per token). rAF is throttled in hidden
    // tabs, so a 50ms timer backstop keeps state advancing there too.
    let deltaBuffer = ''
    let flushScheduled = false
    const flushDeltas = () => {
      flushScheduled = false
      if (!alive || deltaBuffer.length === 0) return
      const chunk = deltaBuffer
      deltaBuffer = ''
      setStreamingText((prev) => prev + chunk)
    }
    const scheduleFlush = () => {
      if (flushScheduled) return
      flushScheduled = true
      if (document.visibilityState === 'hidden') setTimeout(flushDeltas, 50)
      else requestAnimationFrame(flushDeltas)
    }

    const offMessage = wsClient.onMessage((msg) => {
      if (msg.t === 'error') {
        // C5 — a rejected send strands its echo; surface it as retryable
        setPending((prev) => {
          if (prev.length === 0) return prev
          const next = [...prev]
          for (let i = next.length - 1; i >= 0; i--) {
            if (!next[i]!.failed) {
              next[i] = { ...next[i]!, failed: true }
              break
            }
          }
          return next
        })
        return
      }
      if (msg.t === 'event' && msg.sessionId === sessionId) {
        if (msg.event.type === 'assistant_delta') {
          deltaBuffer += msg.event.payload.text
          scheduleFlush()
        } else {
          if (msg.event.type === 'assistant_message' && deltaBuffer) {
            // the finalized message supersedes any unflushed tail
            deltaBuffer = ''
          }
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

  // C5 — send with local echo; the pending row reconciles away by seq
  const sendMessage = useCallback(
    (text: string): boolean => {
      if (!sessionId) return false
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const sent = wsClient.sendUserMessage(sessionId, text)
      setPending((prev) => [...prev, { localId, text, at: new Date().toISOString(), failed: !sent }])
      return sent
    },
    [sessionId],
  )

  const retryPending = useCallback(
    (localId: string) => {
      if (!sessionId) return
      setPending((prev) => {
        const item = prev.find((p) => p.localId === localId)
        if (!item) return prev
        const sent = wsClient.sendUserMessage(sessionId, item.text)
        return prev.map((p) => (p.localId === localId ? { ...p, failed: !sent, at: new Date().toISOString() } : p))
      })
    },
    [sessionId],
  )

  const discardPending = useCallback((localId: string) => {
    setPending((prev) => prev.filter((p) => p.localId !== localId))
  }, [])

  useEffect(() => setPending([]), [sessionId])

  return { detail, events, streamingText, agentStatus, loading, error, pending, sendMessage, retryPending, discardPending }
}
