import type { WebSocket } from 'ws'
import { parseClientMessage, type ClientMessage, type PresenceUser, type ServerMessage } from '@loom/shared'
import type { AgentOrchestrator } from '../agent/orchestrator'
import type { DbHandle } from '../db/client'
import type { ProjectService } from '../projects/service'
import type { SessionService } from '../sessions/service'
import { projectTopic, sessionTopic, type EventBus } from './bus'

type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

interface ConnState {
  socket: WebSocket
  user: UserRow
  /** sessionId → bus unsubscribe */
  sessionSubs: Map<string, () => void>
  /** sessionId → projectId (for presence bookkeeping on unsub/close) */
  sessionProjects: Map<string, string>
  /** projectId → bus unsubscribe */
  projectSubs: Map<string, () => void>
  /** the session this connection is currently looking at (explicit `viewing` message) */
  viewing: string | null
  /** projectId of the viewed session, for presence bookkeeping */
  viewingProject: string | null
  /** serializes message handling — a quick sub/unsub must not race itself */
  chain: Promise<void>
}

const CATCHUP_BATCH_SIZE = 500

/**
 * WebSocket fanout hub. Bus messages are already fully-formed ServerMessages,
 * so subscription is just "forward this topic to this socket". Presence is
 * derived from live connections (single-instance; a Redis-backed bus would
 * move presence into shared state).
 */
export class Hub {
  private conns = new Set<ConnState>()
  /** per-session promise chain — serializes check-then-act critical sections
   * (suggestion resolution) across a driver's multiple connections */
  private sessionLocks = new Map<string, Promise<unknown>>()

  constructor(
    private deps: {
      dbh: DbHandle
      bus: EventBus
      sessions: SessionService
      projects: ProjectService
      orchestrator: AgentOrchestrator
    },
  ) {}

  handleConnection(socket: WebSocket, user: UserRow): void {
    const conn: ConnState = {
      socket,
      user,
      sessionSubs: new Map(),
      sessionProjects: new Map(),
      projectSubs: new Map(),
      viewing: null,
      viewingProject: null,
      chain: Promise.resolve(),
    }
    this.conns.add(conn)
    socket.on('message', (data) => {
      const raw = String(data)
      conn.chain = conn.chain.then(() => this.onMessage(conn, raw)).catch(() => {})
    })
    socket.on('close', () => this.cleanup(conn))
    socket.on('error', () => this.cleanup(conn))
  }

  connectionCount(): number {
    return this.conns.size
  }

  /** How many connections are currently subscribed to a session (driver + spectators). */
  watcherCount(sessionId: string): number {
    let n = 0
    for (const conn of this.conns) if (conn.sessionSubs.has(sessionId)) n++
    return n
  }

  private send(conn: ConnState, msg: ServerMessage): void {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(msg))
    }
  }

  private sendError(conn: ConnState, code: string, message: string): void {
    this.send(conn, { t: 'error', code, message })
  }

  /** Run fn with exclusive access per sessionId (tail-chained promise). */
  private async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    // keep the chain alive but swallow rejections so one failure doesn't wedge it
    this.sessionLocks.set(
      sessionId,
      run.catch(() => {}),
    )
    return run
  }

  private async onMessage(conn: ConnState, raw: string): Promise<void> {
    const msg = parseClientMessage(raw)
    if (!msg) {
      this.sendError(conn, 'bad_message', 'Malformed or unrecognized message')
      return
    }
    try {
      await this.dispatch(conn, msg)
    } catch (err) {
      console.error('[ws] dispatch error:', err)
      this.sendError(conn, 'internal', 'Something went wrong handling that message')
    }
  }

  private async dispatch(conn: ConnState, msg: ClientMessage): Promise<void> {
    const { sessions, projects, orchestrator, bus } = this.deps
    switch (msg.t) {
      case 'sub': {
        const session = await sessions.getSession(msg.sessionId)
        if (!session) return this.sendError(conn, 'not_found', 'Session not found')
        if (!(await projects.isMember(session.projectId, conn.user.id))) {
          return this.sendError(conn, 'forbidden', 'You are not a member of this project')
        }
        if (!conn.sessionSubs.has(msg.sessionId)) {
          const unsub = bus.subscribe(sessionTopic(msg.sessionId), (m) => this.send(conn, m as ServerMessage))
          conn.sessionSubs.set(msg.sessionId, unsub)
          conn.sessionProjects.set(msg.sessionId, session.projectId)
        }
        // NOTE: subscribing ≠ viewing — the spectator sidebar subscribes to
        // streams the user is not focused on; `viewing` is its own message
        return
      }
      case 'unsub': {
        const unsub = conn.sessionSubs.get(msg.sessionId)
        if (unsub) unsub()
        conn.sessionSubs.delete(msg.sessionId)
        const projectId = conn.sessionProjects.get(msg.sessionId)
        conn.sessionProjects.delete(msg.sessionId)
        if (projectId) this.broadcastPresence(projectId)
        return
      }
      case 'viewing': {
        const previousProject = conn.viewingProject
        if (msg.sessionId === null) {
          conn.viewing = null
          conn.viewingProject = null
        } else {
          const session = await sessions.getSession(msg.sessionId)
          if (!session) return
          if (!(await projects.isMember(session.projectId, conn.user.id))) return
          conn.viewing = msg.sessionId
          conn.viewingProject = session.projectId
        }
        if (previousProject && previousProject !== conn.viewingProject) {
          this.broadcastPresence(previousProject)
        }
        if (conn.viewingProject) this.broadcastPresence(conn.viewingProject)
        else if (previousProject) this.broadcastPresence(previousProject)
        return
      }
      case 'sub_project': {
        if (!(await projects.isMember(msg.projectId, conn.user.id))) {
          return this.sendError(conn, 'forbidden', 'You are not a member of this project')
        }
        if (!conn.projectSubs.has(msg.projectId)) {
          const unsub = bus.subscribe(projectTopic(msg.projectId), (m) => this.send(conn, m as ServerMessage))
          conn.projectSubs.set(msg.projectId, unsub)
        }
        this.broadcastPresence(msg.projectId)
        return
      }
      case 'unsub_project': {
        const unsub = conn.projectSubs.get(msg.projectId)
        if (unsub) unsub()
        conn.projectSubs.delete(msg.projectId)
        this.broadcastPresence(msg.projectId)
        return
      }
      case 'user_message': {
        const res = await orchestrator.handleUserMessage(msg.sessionId, conn.user, msg.text)
        if (!res.ok) this.sendError(conn, 'rejected', res.error ?? 'Message rejected')
        return
      }
      case 'stop': {
        const res = await orchestrator.stopTurn(msg.sessionId, conn.user)
        if (!res.ok) this.sendError(conn, 'rejected', res.error ?? 'Could not stop the agent')
        return
      }
      case 'suggest': {
        const session = await sessions.getSession(msg.sessionId)
        if (!session) return this.sendError(conn, 'not_found', 'Session not found')
        if (!(await projects.isMember(session.projectId, conn.user.id))) {
          return this.sendError(conn, 'forbidden', 'You are not a member of this project')
        }
        if (session.status === 'ended') return this.sendError(conn, 'rejected', 'This session has ended')
        if (session.driverUserId === conn.user.id) {
          // the driver just types — suggestions are the spectator's channel
          return this.sendError(conn, 'rejected', 'You are driving this session')
        }
        await sessions.addSuggestion(msg.sessionId, conn.user, msg.text)
        return
      }
      case 'resolve_suggestion': {
        const session = await sessions.getSession(msg.sessionId)
        if (!session) return this.sendError(conn, 'not_found', 'Session not found')
        if (session.driverUserId !== conn.user.id) {
          return this.sendError(conn, 'forbidden', 'Only the driver can resolve suggestions')
        }
        // Serialize per session so two driver tabs can't both pass the
        // pendingness check before either records a decision (which would
        // persist contradictory decisions and run a dismissed suggestion).
        await this.withSessionLock(msg.sessionId, async () => {
          const pending = await sessions.getPendingSuggestion(msg.sessionId, msg.suggestionId)
          if (!pending) return this.sendError(conn, 'rejected', 'That suggestion was already handled')
          if (msg.decision === 'dismissed') {
            await sessions.recordSuggestionDecision(msg.sessionId, msg.suggestionId, 'dismissed', conn.user.name)
            return
          }
          // accepted: only the driver's accept turns a suggestion into agent work.
          // start the turn first; record the decision only if it actually started,
          // so a busy session doesn't leave a suggestion marked accepted-but-idle.
          const res = await orchestrator.handleUserMessage(msg.sessionId, conn.user, pending.text, {
            suggestedBy: { userId: pending.suggesterUserId, name: pending.suggesterName },
          })
          if (!res.ok) return this.sendError(conn, 'rejected', res.error ?? 'Could not run the suggestion')
          await sessions.recordSuggestionDecision(msg.sessionId, msg.suggestionId, 'accepted', conn.user.name)
        })
        return
      }
      case 'catchup': {
        const session = await sessions.getSession(msg.sessionId)
        if (!session) return this.sendError(conn, 'not_found', 'Session not found')
        if (!(await projects.isMember(session.projectId, conn.user.id))) {
          return this.sendError(conn, 'forbidden', 'You are not a member of this project')
        }
        const events = await sessions.getEvents(msg.sessionId, msg.afterSeq)
        for (let i = 0; i < events.length; i += CATCHUP_BATCH_SIZE) {
          this.send(conn, {
            t: 'catchup_batch',
            sessionId: msg.sessionId,
            events: events.slice(i, i + CATCHUP_BATCH_SIZE),
          })
        }
        if (events.length === 0) {
          this.send(conn, { t: 'catchup_batch', sessionId: msg.sessionId, events: [] })
        }
        return
      }
    }
  }

  private presenceFor(projectId: string): PresenceUser[] {
    const byUser = new Map<string, PresenceUser>()
    for (const conn of this.conns) {
      if (!conn.projectSubs.has(projectId)) continue
      const existing = byUser.get(conn.user.id)
      const viewing = conn.viewing ?? existing?.viewing ?? null
      byUser.set(conn.user.id, {
        userId: conn.user.id,
        name: conn.user.name,
        avatarColor: conn.user.avatarColor,
        viewing,
      })
    }
    return [...byUser.values()]
  }

  broadcastPresence(projectId: string): void {
    const msg: ServerMessage = { t: 'presence', projectId, users: this.presenceFor(projectId) }
    for (const conn of this.conns) {
      if (conn.projectSubs.has(projectId)) this.send(conn, msg)
    }
  }

  private cleanup(conn: ConnState): void {
    if (!this.conns.has(conn)) return
    this.conns.delete(conn)
    for (const unsub of conn.sessionSubs.values()) unsub()
    for (const unsub of conn.projectSubs.values()) unsub()
    const projectIds = new Set([...conn.projectSubs.keys(), ...conn.sessionProjects.values()])
    conn.sessionSubs.clear()
    conn.projectSubs.clear()
    for (const projectId of projectIds) this.broadcastPresence(projectId)
  }
}
