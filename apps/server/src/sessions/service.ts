import path from 'node:path'
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  eventGist,
  eventPayloadSchemas,
  sessionEventSchema,
  shortId,
  slugify,
  type EventPayloadOf,
  type ProjectUpdate,
  type ServerMessage,
  type SessionEvent,
  type SessionEventType,
  type SessionSummary,
} from '@loom/shared'
import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import { GitService } from '../git/gitService'
import { projectTopic, sessionTopic, type EventBus } from '../realtime/bus'

type SessionRow = typeof import('../db/schema.sqlite').sessions.$inferSelect
type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

/** Event types that should surface as a live one-line gist on the dashboard. */
const GIST_TYPES: Set<SessionEventType> = new Set([
  'user_message',
  'tool_call',
  'file_change',
  'commit',
  'status',
])

export class SessionService {
  constructor(
    private dbh: DbHandle,
    private bus: EventBus,
    private config: ServerConfig,
  ) {}

  gitForRepo(repoPath: string): GitService {
    return new GitService(repoPath)
  }

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  /**
   * Append a persisted event: insert with the next per-session seq, then
   * publish to the session topic (and a gist to the project topic).
   * This is the single write path for the source-of-truth log.
   */
  async appendEvent<T extends SessionEventType>(
    sessionId: string,
    type: T,
    payload: EventPayloadOf<T>,
  ): Promise<SessionEvent> {
    const { db, t } = this.dbh
    const id = ulid()
    const createdAt = new Date().toISOString()
    // The subselect assigns the next per-session seq atomically per statement.
    // SQLite serializes writes; on Postgres two concurrent appends (e.g. a
    // fork_marker landing during a turn) can race to the same seq and trip the
    // unique (session_id, seq) index — retrying recomputes the subselect.
    let seq = 0
    for (let attempt = 0; ; attempt++) {
      try {
        const rows = await db
          .insert(t.sessionEvents)
          .values({
            id,
            sessionId,
            type,
            payload: JSON.stringify(payload),
            createdAt,
            seq: sql<number>`(select coalesce(max(${t.sessionEvents.seq}), 0) + 1 from ${t.sessionEvents} where ${t.sessionEvents.sessionId} = ${sessionId})`,
          })
          .returning({ seq: t.sessionEvents.seq })
        seq = rows[0]?.seq ?? 0
        break
      } catch (err) {
        if (attempt < 4 && /unique|23505/i.test(String(err))) continue
        throw err
      }
    }

    await db.update(t.sessions).set({ lastEventAt: createdAt }).where(eq(t.sessions.id, sessionId))

    const event = { id, sessionId, seq, type, payload, createdAt } as SessionEvent
    this.broadcastEvent(event)
    return event
  }

  /** Broadcast-only events (assistant_delta). Never persisted; seq is null. */
  publishTransient<T extends SessionEventType>(sessionId: string, type: T, payload: EventPayloadOf<T>): void {
    const event = {
      id: ulid(),
      sessionId,
      seq: null,
      type,
      payload,
      createdAt: new Date().toISOString(),
    } as SessionEvent
    const msg: ServerMessage = { t: 'event', sessionId, event }
    this.bus.publish(sessionTopic(sessionId), msg)
  }

  private broadcastEvent(event: SessionEvent): void {
    const msg: ServerMessage = { t: 'event', sessionId: event.sessionId, event }
    this.bus.publish(sessionTopic(event.sessionId), msg)

    if (GIST_TYPES.has(event.type)) {
      // fire-and-forget project gist for dashboard liveness
      void this.publishActivityGist(event)
    }
  }

  private async publishActivityGist(event: SessionEvent): Promise<void> {
    const session = await this.getSession(event.sessionId)
    if (!session) return
    const driver = await this.getUser(session.driverUserId)
    const update: ProjectUpdate = {
      kind: 'session_activity',
      sessionId: session.id,
      moduleId: session.moduleId,
      driverUserId: session.driverUserId,
      driverName: driver?.name ?? 'Someone',
      gist: eventGist(event),
      at: event.createdAt,
    }
    this.publishProjectUpdate(session.projectId, update)
  }

  publishProjectUpdate(projectId: string, update: ProjectUpdate): void {
    const msg: ServerMessage = { t: 'project_update', projectId, update }
    this.bus.publish(projectTopic(projectId), msg)
  }

  /** All persisted events with seq > afterSeq, in order. */
  async getEvents(sessionId: string, afterSeq = 0, limit = 5000): Promise<SessionEvent[]> {
    const { db, t } = this.dbh
    const rows = await db
      .select()
      .from(t.sessionEvents)
      .where(and(eq(t.sessionEvents.sessionId, sessionId), gt(t.sessionEvents.seq, afterSeq)))
      .orderBy(asc(t.sessionEvents.seq))
      .limit(limit)
    const events: SessionEvent[] = []
    for (const row of rows) {
      const parsed = this.parseEventRow(row)
      if (parsed) events.push(parsed)
    }
    return events
  }

  private parseEventRow(row: typeof import('../db/schema.sqlite').sessionEvents.$inferSelect): SessionEvent | null {
    try {
      const payload = JSON.parse(row.payload)
      const candidate = {
        id: row.id,
        sessionId: row.sessionId,
        seq: row.seq,
        type: row.type,
        payload,
        createdAt: row.createdAt,
      }
      const res = sessionEventSchema.safeParse(candidate)
      return res.success ? res.data : null
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async getSession(id: string): Promise<SessionRow | null> {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.sessions).where(eq(t.sessions.id, id))
    return rows[0] ?? null
  }

  private async getUser(id: string): Promise<UserRow | null> {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.users).where(eq(t.users.id, id))
    return rows[0] ?? null
  }

  async toSummary(session: SessionRow): Promise<SessionSummary> {
    const driver = await this.getUser(session.driverUserId)
    return {
      id: session.id,
      moduleId: session.moduleId,
      projectId: session.projectId,
      driverUserId: session.driverUserId,
      driverName: driver?.name ?? 'Unknown',
      driverAvatarColor: driver?.avatarColor ?? '#8b7cf6',
      title: session.title,
      status: session.status as SessionSummary['status'],
      branchName: session.branchName,
      parentSessionId: session.parentSessionId,
      forkedAtEventId: session.forkedAtEventId,
      lastEventAt: session.lastEventAt,
      createdAt: session.createdAt,
    }
  }

  /**
   * Start a new session in a module: cut branch `session/<moduleSlug>/<id>`
   * from the module's latest commit (or main), add a git worktree for it.
   */
  async createSession(moduleId: string, driver: UserRow, title?: string): Promise<SessionRow> {
    const { db, t } = this.dbh
    const moduleRows = await db.select().from(t.modules).where(eq(t.modules.id, moduleId))
    const module = moduleRows[0]
    if (!module) throw new Error('Module not found')
    const projectRows = await db.select().from(t.projects).where(eq(t.projects.id, module.projectId))
    const project = projectRows[0]
    if (!project) throw new Error('Project not found')

    const git = this.gitForRepo(project.repoPath)
    const baseSha = await this.latestModuleCommit(moduleId, git)

    const sessionId = ulid()
    const branchName = `session/${slugify(module.name)}/${shortId()}`
    const worktreePath = path.join(this.config.dataDir, 'projects', project.id, 'worktrees', sessionId)
    await git.createWorktree(worktreePath, branchName, baseSha)

    const countRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(t.sessions)
      .where(eq(t.sessions.moduleId, moduleId))
    const n = Number(countRows[0]?.n ?? 0) + 1

    const now = new Date().toISOString()
    const session: SessionRow = {
      id: sessionId,
      moduleId,
      projectId: project.id,
      driverUserId: driver.id,
      title: title?.trim() || `${module.name} session #${n}`,
      status: 'idle',
      branchName,
      worktreePath,
      parentSessionId: null,
      forkedAtEventId: null,
      lastEventAt: now,
      createdAt: now,
    }
    await db.insert(t.sessions).values(session)

    await this.appendEvent(sessionId, 'status', {
      status: 'idle',
      note: `${driver.name} started a session in ${module.emoji} ${module.name}`,
    })
    this.publishProjectUpdate(project.id, { kind: 'session_started', session: await this.toSummary(session) })
    return session
  }

  /** Latest commit sha authored in this module (via changes), falling back to main. */
  private async latestModuleCommit(moduleId: string, git: GitService): Promise<string> {
    const { db, t } = this.dbh
    const rows = await db
      .select({ sha: t.changes.commitSha })
      .from(t.changes)
      .innerJoin(t.sessions, eq(t.changes.sessionId, t.sessions.id))
      .where(eq(t.sessions.moduleId, moduleId))
      .orderBy(desc(t.changes.createdAt))
      .limit(1)
    const sha = rows[0]?.sha
    if (sha) {
      try {
        await git.currentSha(sha)
        return sha
      } catch {
        // commit disappeared (e.g. repo rebuilt) — fall through to main
      }
    }
    return git.currentSha('main')
  }

  /**
   * Fork: copy the event log up to `atEventId` (default: latest), cut a new
   * branch from the last commit event at-or-before that point, and record
   * lineage. The source session is completely unaffected.
   */
  async forkSession(sourceSessionId: string, newDriver: UserRow, atEventId?: string): Promise<SessionRow> {
    const { db, t } = this.dbh
    const source = await this.getSession(sourceSessionId)
    if (!source) throw new Error('Session not found')
    const moduleRows = await db.select().from(t.modules).where(eq(t.modules.id, source.moduleId))
    const module = moduleRows[0]
    if (!module) throw new Error('Module not found')
    const projectRows = await db.select().from(t.projects).where(eq(t.projects.id, source.projectId))
    const project = projectRows[0]
    if (!project) throw new Error('Project not found')
    const sourceDriver = await this.getUser(source.driverUserId)

    const allEvents = await this.getEvents(sourceSessionId, 0)
    let cutoffSeq = allEvents.length > 0 ? allEvents[allEvents.length - 1]!.seq! : 0
    if (atEventId) {
      const at = allEvents.find((e) => e.id === atEventId)
      if (!at || at.seq === null) throw new Error('Event not found in source session')
      cutoffSeq = at.seq
    }
    const inCut = allEvents.filter((e) => e.seq !== null && e.seq <= cutoffSeq)
    const cutoffEvent = inCut[inCut.length - 1] ?? null
    const copied = inCut.filter(
      (e) =>
        // the source's lifecycle notes don't belong in the fork's story, and
        // transient in-flight statuses (thinking/running_tools) must not be
        // copied: the fork's LAST status event drives its composer state, and
        // a copied "thinking" would brick it forever
        !(
          e.type === 'status' &&
          (e.payload.note === 'Session ended' ||
            e.payload.status === 'thinking' ||
            e.payload.status === 'running_tools')
        ),
    )

    // branch point: last commit event at-or-before the cutoff. With no commit
    // in the slice, DON'T use the source branch's live HEAD — later turns may
    // already have committed past the fork point. The branch state at the
    // cutoff is the parent of the first commit AFTER the cutoff (== the
    // branch's creation base, since commits are strictly sequential); only
    // when the source has no commits at all is its HEAD the true base.
    const lastCommit = [...copied].reverse().find((e) => e.type === 'commit')
    const git = this.gitForRepo(project.repoPath)
    let baseSha: string
    if (lastCommit && lastCommit.type === 'commit') {
      baseSha = lastCommit.payload.commitSha
    } else {
      const nextCommit = allEvents.find((e) => e.type === 'commit' && (e.seq ?? 0) > cutoffSeq)
      baseSha =
        nextCommit && nextCommit.type === 'commit'
          ? await git.currentSha(`${nextCommit.payload.commitSha}^`)
          : await git.currentSha(source.branchName)
    }

    const sessionId = ulid()
    const branchName = `session/${slugify(module.name)}/${shortId()}`
    const worktreePath = path.join(this.config.dataDir, 'projects', project.id, 'worktrees', sessionId)
    await git.createWorktree(worktreePath, branchName, baseSha)

    const now = new Date().toISOString()
    const session: SessionRow = {
      id: sessionId,
      moduleId: source.moduleId,
      projectId: source.projectId,
      driverUserId: newDriver.id,
      title: `Fork of ${source.title}`,
      status: 'idle',
      branchName,
      worktreePath,
      parentSessionId: source.id,
      forkedAtEventId: cutoffEvent?.id ?? null,
      lastEventAt: now,
      createdAt: now,
    }
    await db.insert(t.sessions).values(session)

    // leading marker, then the copied log (fresh ids, original timestamps)
    const rowsToInsert = [
      {
        id: ulid(),
        sessionId,
        seq: 1,
        type: 'status',
        payload: JSON.stringify({
          status: 'idle',
          note: `Forked from ${sourceDriver?.name ?? 'a teammate'}'s session “${source.title}”`,
        } satisfies EventPayloadOf<'status'>),
        createdAt: now,
      },
      ...copied.map((e, i) => ({
        id: ulid(),
        sessionId,
        seq: i + 2,
        type: e.type,
        payload: JSON.stringify(e.payload),
        createdAt: e.createdAt,
      })),
      // belt-and-braces: whatever the copied slice ended on, the fork starts
      // with an idle agent — the composer must never inherit a busy state
      {
        id: ulid(),
        sessionId,
        seq: copied.length + 2,
        type: 'status',
        payload: JSON.stringify({ status: 'idle' } satisfies EventPayloadOf<'status'>),
        createdAt: now,
      },
    ]
    // chunked bulk insert (SQLite parameter limits)
    for (let i = 0; i < rowsToInsert.length; i += 100) {
      await db.insert(t.sessionEvents).values(rowsToInsert.slice(i, i + 100))
    }

    // tell the source session's spectators
    await this.appendEvent(sourceSessionId, 'fork_marker', {
      childSessionId: sessionId,
      byUserName: newDriver.name,
    })

    this.publishProjectUpdate(project.id, { kind: 'session_started', session: await this.toSummary(session) })
    return session
  }

  // -------------------------------------------------------------------------
  // Spectator suggestions (append-only; the driver is still the single writer)
  // -------------------------------------------------------------------------

  async addSuggestion(sessionId: string, suggester: UserRow, text: string): Promise<SessionEvent> {
    return this.appendEvent(sessionId, 'suggestion', {
      suggestionId: ulid(),
      text,
      suggesterUserId: suggester.id,
      suggesterName: suggester.name,
      suggesterColor: suggester.avatarColor,
    })
  }

  /** The suggestion's payload if it exists AND has not been resolved yet, else null. */
  async getPendingSuggestion(
    sessionId: string,
    suggestionId: string,
  ): Promise<EventPayloadOf<'suggestion'> | null> {
    const events = await this.getEvents(sessionId, 0)
    let found: EventPayloadOf<'suggestion'> | null = null
    let decided = false
    for (const e of events) {
      if (e.type === 'suggestion' && e.payload.suggestionId === suggestionId) found = e.payload
      if (e.type === 'suggestion_decision' && e.payload.suggestionId === suggestionId) decided = true
    }
    return found && !decided ? found : null
  }

  async recordSuggestionDecision(
    sessionId: string,
    suggestionId: string,
    decision: 'accepted' | 'dismissed',
    decidedByName: string,
  ): Promise<SessionEvent> {
    return this.appendEvent(sessionId, 'suggestion_decision', { suggestionId, decision, decidedByName })
  }

  async endSession(sessionId: string): Promise<void> {
    const { db, t } = this.dbh
    const session = await this.getSession(sessionId)
    if (!session || session.status === 'ended') return
    await db.update(t.sessions).set({ status: 'ended' }).where(eq(t.sessions.id, sessionId))
    await this.appendEvent(sessionId, 'status', { status: 'idle', note: 'Session ended' })
    this.publishProjectUpdate(session.projectId, {
      kind: 'session_ended',
      sessionId,
      moduleId: session.moduleId,
    })
  }

  /**
   * Lifecycle guard: a session that was ended mid-turn must STAY ended — the
   * in-flight turn's trailing "back to idle/active" update loses to `ended`.
   */
  async setSessionRowStatus(sessionId: string, status: 'active' | 'idle' | 'ended'): Promise<void> {
    const { db, t } = this.dbh
    const where =
      status === 'ended'
        ? eq(t.sessions.id, sessionId)
        : and(eq(t.sessions.id, sessionId), ne(t.sessions.status, 'ended'))
    await db.update(t.sessions).set({ status }).where(where)
  }

  async listSessionsForModule(moduleId: string): Promise<SessionRow[]> {
    const { db, t } = this.dbh
    return db
      .select()
      .from(t.sessions)
      .where(eq(t.sessions.moduleId, moduleId))
      .orderBy(desc(t.sessions.lastEventAt))
  }

  async listActiveSessionsForProject(projectId: string): Promise<SessionRow[]> {
    const { db, t } = this.dbh
    return db
      .select()
      .from(t.sessions)
      .where(and(eq(t.sessions.projectId, projectId), ne(t.sessions.status, 'ended')))
      .orderBy(desc(t.sessions.lastEventAt))
  }

  async countChangesForSession(sessionId: string): Promise<number> {
    const { db, t } = this.dbh
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(t.changes)
      .where(eq(t.changes.sessionId, sessionId))
    return Number(rows[0]?.n ?? 0)
  }

  /** Cumulative token + cost totals per session, summed from `usage` events. */
  async usageTotalsForSessions(sessionIds: string[]): Promise<Map<string, { tokens: number; costUsd: number }>> {
    const out = new Map<string, { tokens: number; costUsd: number }>()
    if (sessionIds.length === 0) return out
    const { db, t } = this.dbh
    const rows = await db
      .select({ sessionId: t.sessionEvents.sessionId, payload: t.sessionEvents.payload })
      .from(t.sessionEvents)
      .where(and(inArray(t.sessionEvents.sessionId, sessionIds), eq(t.sessionEvents.type, 'usage')))
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload) as { inputTokens: number; outputTokens: number; costUsd: number }
        const cur = out.get(row.sessionId) ?? { tokens: 0, costUsd: 0 }
        cur.tokens += (p.inputTokens ?? 0) + (p.outputTokens ?? 0)
        cur.costUsd += p.costUsd ?? 0
        out.set(row.sessionId, cur)
      } catch {
        // skip malformed usage row
      }
    }
    return out
  }
}
