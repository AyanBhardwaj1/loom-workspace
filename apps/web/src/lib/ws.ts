import { parseServerMessage, type ClientMessage, type ServerMessage } from '@loom/shared'

type MessageListener = (msg: ServerMessage) => void
type OpenListener = () => void

/**
 * Thin WebSocket client: one connection for the whole app, auto-reconnect
 * with backoff, and automatic re-subscription of sessions/projects after a
 * reconnect (each consumer then re-catchups from its own lastSeq).
 */
class WSClient {
  private ws: WebSocket | null = null
  private listeners = new Set<MessageListener>()
  private openListeners = new Set<OpenListener>()
  private sessionSubs = new Map<string, number>() // refcounts
  private projectSubs = new Map<string, number>()
  private reconnectDelay = 800
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private viewing: string | null = null

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.closedByUser = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 800
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
      this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 8000)
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  disconnect(): void {
    this.closedByUser = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  isOpen(): boolean {
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

  private raw(msg: ClientMessage): void {
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

  /** Returns false when the socket is down — callers must NOT drop user text silently. */
  sendUserMessage(sessionId: string, text: string): boolean {
    if (!this.isOpen()) {
      this.connect()
      return false
    }
    this.raw({ t: 'user_message', sessionId, text })
    return true
  }

  catchup(sessionId: string, afterSeq: number): void {
    this.raw({ t: 'catchup', sessionId, afterSeq })
  }
}

export const wsClient = new WSClient()
