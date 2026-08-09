import { useEffect, useRef, useState } from 'react'
import type { SessionDetail, SessionEvent } from '@loom/shared'
import { api } from '../lib/api'
import { wsClient } from '../lib/ws'

export interface ReplayStream {
  detail: SessionDetail | null
  /** the full persisted event log, in seq order (no transient deltas) */
  events: SessionEvent[]
  loading: boolean
  error: string | null
}

/**
 * Data source for the replay player: a read-only snapshot from `/api/replay`
 * (the single authorization seam for shared links), plus live appends over the
 * WebSocket so a replay of a still-live session keeps growing. Deltas are
 * ignored — replay reconstructs purely from the persisted log.
 */
export function useReplayStream(sessionId: string | null): ReplayStream {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastSeqRef = useRef(0)

  useEffect(() => {
    if (!sessionId) {
      setDetail(null)
      setEvents([])
      setLoading(false)
      return
    }
    let alive = true
    lastSeqRef.current = 0
    setLoading(true)
    setError(null)
    setEvents([])
    setDetail(null)
    const seen = new Set<string>()

    const ingest = (incoming: SessionEvent[]) => {
      if (!alive) return
      const fresh = incoming.filter((e) => e.seq !== null && !seen.has(e.id))
      if (fresh.length === 0) return
      for (const e of fresh) {
        seen.add(e.id)
        if (e.seq! > lastSeqRef.current) lastSeqRef.current = e.seq!
      }
      setEvents((prev) => [...prev, ...fresh].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)))
    }

    const offMessage = wsClient.onMessage((msg) => {
      if (msg.t === 'event' && msg.sessionId === sessionId && msg.event.type !== 'assistant_delta') {
        ingest([msg.event])
      } else if (msg.t === 'catchup_batch' && msg.sessionId === sessionId) {
        ingest(msg.events)
      }
    })
    const offOpen = wsClient.onOpen(() => wsClient.catchup(sessionId, lastSeqRef.current))
    const unsub = wsClient.subSession(sessionId)

    void (async () => {
      try {
        const d = await api.get<SessionDetail>(`/api/replay/${sessionId}`)
        if (!alive) return
        setDetail(d)
        ingest(d.events)
        wsClient.catchup(sessionId, d.lastSeq)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Failed to load replay')
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

  return { detail, events, loading, error }
}
