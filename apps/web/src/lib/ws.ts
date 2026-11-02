import { parseServerMessage, type ClientMessage, type ServerMessage } from '@loom/shared'

export type PreviewPresenceFrame = Omit<Extract<ClientMessage, { t: 'preview_presence' }>, 't' | 'sessionId'>

type MessageListener = (msg: ServerMessage) => void
type OpenListener = () => void
export type ConnectionStatus = 'open' | 'reconnecting'
type StatusListener = (status: ConnectionStatus) => void

/**
 * Thin WebSocket client: one connection for the whole app, auto-reconnect
 * with backoff, and automatic re-subscription of sessions/projects after a
 * reconnect (each consumer then re-catchups from its own lastSeq).
 */
class WSClient {
  private ws: WebSocket | null = null
  private listeners = new Set<MessageListener>()
  private openListeners = new Set<OpenListener>()
  private statusListeners = new Set<StatusListener>()
  private status: ConnectionStatus = 'reconnecting'
  private sessionSubs = new Map<string, number>() // refcounts
  private projectSubs = new Map<string, number>()
  private reconnectDelay = 800
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private viewing: string | null = null
  private reading: { sessionId: string; eventId: string | null } | null = null

  // ---- HTTP long-poll transport (serverless hosts like Vercel: no sockets) ----
  private readonly polling = import.meta.env.VITE_LOOM_REALTIME === 'poll'
  private readonly clientId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  private pollRunning = false
  private pollAbort: AbortController | null = null
  private pollCursor: number | null = null
  private pollFresh = true
  private seenOids = new Set<number>()
  private outbox: ClientMessage[] = []
  private outboxTimer: ReturnType<typeof setTimeout> | null = null

  private dispatch(msg: ServerMessage): void {
    for (const l of [...this.listeners]) l(msg)
  }

  private async pollLoop(): Promise<void> {
    if (this.pollRunning) return
    this.pollRunning = true
    let delay = 800
    while (!this.closedByUser) {
      const abort = new AbortController()
      this.pollAbort = abort
      try {
        const res = await fetch('/api/rt/poll', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            clientId: this.clientId,
            cursor: this.pollCursor,
            sessions: [...this.sessionSubs.keys()],
            projects: [...this.projectSubs.keys()],
            viewing: this.viewing,
            reading: this.reading && this.reading.sessionId === this.viewing ? this.reading.eventId : null,
            // answer at once after a state change or a reconnect; otherwise hold the line
            waitMs: this.pollFresh ? 0 : 8000,
          }),
          signal: abort.signal,
        })
        if (!res.ok) throw new Error(`poll ${res.status}`)
        const data = (await res.json()) as { cursor: number; messages: unknown[] }
        const wasOpen = this.status === 'open'
        this.pollCursor = data.cursor
        this.pollFresh = false
        delay = 800
        this.setStatus('open')
        // the first good poll after a gap is a (re)open: consumers re-catchup
        if (!wasOpen) for (const l of [...this.openListeners]) l()
        for (const raw of data.messages) {
          // the server re-sends a small overlap window; deliver each outbox row once
          const oid = (raw as { _oid?: unknown })._oid
          if (typeof oid === 'number') {
            if (this.seenOids.has(oid)) continue
            this.seenOids.add(oid)
            if (this.seenOids.size > 4000) this.seenOids = new Set([...this.seenOids].slice(-2000))
          }
          const msg = parseServerMessage(JSON.stringify(raw))
          if (msg) this.dispatch(msg)
        }
      } catch (err) {
        if (abort.signal.aborted) continue // a deliberate re-poll (state changed)
        this.setStatus('reconnecting')
        this.pollFresh = true
        const jitter = 0.75 + Math.random() * 0.5
        await new Promise((r) => setTimeout(r, Math.round(delay * jitter)))
        delay = Math.min(delay * 1.6, 8000)
        void err
      }
    }
    this.pollRunning = false
  }

  /** subscriptions/viewing changed: re-poll now so the server (and presence) catch up */
  private kickPoll(): void {
    if (!this.polling) return
    this.pollFresh = true
    this.pollAbort?.abort()
  }

  private queueSend(msg: ClientMessage): void {
    // pointer moves are latest-wins per session: only the newest needs to travel
    if (msg.t === 'preview_presence' && msg.kind === 'move') {
      this.outbox = this.outbox.filter((m) => !(m.t === 'preview_presence' && m.kind === 'move' && m.sessionId === msg.sessionId))
    }
    this.outbox.push(msg)
    if (this.outboxTimer) return
    this.outboxTimer = setTimeout(() => void this.flushOutbox(), msg.t === 'preview_presence' ? 120 : 0)
  }

  private async flushOutbox(): Promise<void> {
    this.outboxTimer = null
    const batch = this.outbox
    this.outbox = []
    if (batch.length === 0) return
    try {
      const res = await fetch('/api/rt/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: this.clientId, messages: batch.map((m) => JSON.stringify(m)) }),
      })
      if (!res.ok) throw new Error(`send ${res.status}`)
      const data = (await res.json()) as { replies: unknown[] }
      for (const raw of data.replies) {
        const msg = parseServerMessage(JSON.stringify(raw))
        if (msg) this.dispatch(msg)
      }
    } catch {
      // surface it like a socket error so optimistic UI marks the send as failed
      this.dispatch({ t: 'error', code: 'network', message: 'Connection lost — try again in a second.' })
    }
  }

  connect(): void {
    if (this.polling) {
      this.closedByUser = false
      void this.pollLoop()
      return
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.closedByUser = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 800
      this.setStatus('open')
      // restore server-side subscriptions lost with the old socket
      for (const sessionId of this.sessionSubs.keys()) this.raw({ t: 'sub', sessionId })
      for (const projectId of this.projectSubs.keys()) this.raw({ t: 'sub_project', projectId })
      if (this.viewing) this.raw({ t: 'viewing', sessionId: this.viewing })
      for (const l of [...this.openListeners]) l()
    }
    ws.onmessage = (e) => {
      const msg = parseServerMessage(String(e.data))
      if (!msg) return
      for (const l of [...this.listeners]) l(msg)
    }
    ws.onclose = () => {
      this.ws = null
      if (this.closedByUser) return
      this.setStatus('reconnecting')
      // C4: exponential backoff with jitter — reconnect stampedes thunder
      // less when a server restart drops every client at once
      const jitter = 0.75 + Math.random() * 0.5
      this.reconnectTimer = setTimeout(() => this.connect(), Math.round(this.reconnectDelay * jitter))
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 8000)
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  disconnect(): void {
    this.closedByUser = true
    if (this.polling) {
      this.pollAbort?.abort()
      void fetch('/api/rt/leave', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: this.clientId }), keepalive: true }).catch(() => {})
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  isOpen(): boolean {
    if (this.polling) return this.status === 'open'
    return this.ws?.readyState === WebSocket.OPEN
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Fires whenever the socket (re)opens — consumers re-catchup here. */
  onOpen(listener: OpenListener): () => void {
    this.openListeners.add(listener)
    return () => this.openListeners.delete(listener)
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.status) return
    this.status = status
    for (const l of [...this.statusListeners]) l(status)
  }

  /** Connection status for the reconnect banner (fires on change; call getStatus for current). */
  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private raw(msg: ClientMessage): void {
    if (this.polling) {
      // subscriptions and presence are declared on every poll, not sent
      if (msg.t === 'sub' || msg.t === 'unsub' || msg.t === 'sub_project' || msg.t === 'unsub_project' || msg.t === 'viewing') {
        this.kickPoll()
        return
      }
      if (msg.t === 'reading') {
        this.reading = { sessionId: msg.sessionId, eventId: msg.eventId }
        return
      }
      this.queueSend(msg)
      return
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  subSession(sessionId: string): () => void {
    const n = this.sessionSubs.get(sessionId) ?? 0
    this.sessionSubs.set(sessionId, n + 1)
    if (n === 0) this.raw({ t: 'sub', sessionId })
    this.connect()
    return () => {
      const count = (this.sessionSubs.get(sessionId) ?? 1) - 1
      if (count <= 0) {
        this.sessionSubs.delete(sessionId)
        this.raw({ t: 'unsub', sessionId })
      } else {
        this.sessionSubs.set(sessionId, count)
      }
    }
  }

  subProject(projectId: string): () => void {
    const n = this.projectSubs.get(projectId) ?? 0
    this.projectSubs.set(projectId, n + 1)
    if (n === 0) this.raw({ t: 'sub_project', projectId })
    this.connect()
    return () => {
      const count = (this.projectSubs.get(projectId) ?? 1) - 1
      if (count <= 0) {
        this.projectSubs.delete(projectId)
        this.raw({ t: 'unsub_project', projectId })
      } else {
        this.projectSubs.set(projectId, count)
      }
    }
  }

  /** Presence hint: what the user is looking at (independent of subscriptions). */
  setViewing(sessionId: string | null): void {
    this.viewing = sessionId
    this.raw({ t: 'viewing', sessionId })
  }

  /** F5: ephemeral read position within the viewed session (callers throttle). */
  setReading(sessionId: string, eventId: string | null): void {
    this.raw({ t: 'reading', sessionId, eventId })
  }

  /** Returns false when the socket is down — callers must NOT drop user text silently. */
  sendUserMessage(sessionId: string, text: string): boolean {
    if (!this.isOpen()) {
      this.connect()
      return false
    }
    this.raw({ t: 'user_message', sessionId, text })
    return true
  }

  /** Driver redirects the running agent; the server hands it over at the next tool boundary. */
  steer(sessionId: string, text: string): boolean {
    if (!this.isOpen()) {
      this.connect()
      return false
    }
    this.raw({ t: 'steer', sessionId, text })
    return true
  }

  /** Driver interrupts the in-flight turn. */
  stop(sessionId: string): void {
    this.raw({ t: 'stop', sessionId })
  }

  /** Spectator proposes a next step (server rejects if you're the driver). */
  suggest(sessionId: string, text: string): boolean {
    if (!this.isOpen()) {
      this.connect()
      return false
    }
    this.raw({ t: 'suggest', sessionId, text })
    return true
  }

  /** Driver accepts or dismisses a spectator suggestion. */
  resolveSuggestion(sessionId: string, suggestionId: string, decision: 'accepted' | 'dismissed'): void {
    this.raw({ t: 'resolve_suggestion', sessionId, suggestionId, decision })
  }

  catchup(sessionId: string, afterSeq: number): void {
    this.raw({ t: 'catchup', sessionId, afterSeq })
  }

  /** 1.2: transient emoji reaction (atSeq anchors a row; null = live edge). */
  react(sessionId: string, emoji: string, atSeq: number | null): void {
    this.raw({ t: 'react', sessionId, emoji, atSeq })
  }

  /** F8: pin a reaction or comment to an event. */
  annotate(sessionId: string, targetEventId: string, kind: 'reaction' | 'comment', body: string): boolean {
    if (!this.isOpen()) {
      this.connect()
      return false
    }
    this.raw({ t: 'annotate', sessionId, targetEventId, kind, body })
    return true
  }

  /** Live co-testing: relay one frame from this viewer's preview iframe (callers pre-validate). */
  previewPresence(sessionId: string, frame: PreviewPresenceFrame): void {
    this.raw({ t: 'preview_presence', sessionId, ...frame })
  }

  /** F9: driver offers the wheel to a member. */
  handoffOffer(sessionId: string, toUserId: string): void {
    this.raw({ t: 'handoff_offer', sessionId, toUserId })
  }

  /** F9: the offered member accepts or declines. */
  handoffResponse(sessionId: string, accept: boolean): void {
    this.raw({ t: 'handoff_response', sessionId, accept })
  }

  /** C4: called on visibilitychange→visible — reconnect now or re-catchup. */
  resyncAfterWake(): void {
    if (this.closedByUser) return
    if (this.polling) {
      this.kickPoll()
      for (const l of [...this.openListeners]) l()
      return
    }
    if (this.isOpen()) {
      // socket survived; consumers re-fetch anything they missed
      for (const l of [...this.openListeners]) l()
    } else {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectDelay = 800
      this.connect()
    }
  }
}

export const wsClient = new WSClient()

// C4 — fast resync on tab return: consumers re-catchup from their lastSeq
// (the same path as a reconnect), and a socket that died while hidden
// reconnects immediately instead of waiting out its backoff.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wsClient.resyncAfterWake()
  })
}
