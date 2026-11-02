import { WRITE_TOOLS, matchesProtected, type AgentToolExecution, type AgentTurnContext, type EventPayloadOf } from '@loom/shared'
import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import type { ProjectService } from '../projects/service'
import type { SessionService } from '../sessions/service'
import pino from 'pino'
import { countAssistantTurns, foldBrief, foldTranscript } from './context'

/** C7 — agent-turn telemetry: start/end, duration, tool timings. */
const turnLog = pino({ name: 'agent', level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' })
import { estimateCostUsd } from './pricing'
import type { AgentRuntime } from './runtime'
import { ToolExecutor } from './tools'
import { ulid } from 'ulid'
import { runChecks } from '../checks/runChecks'
import { keepAlive } from '../platform/keepAlive'
import type { Coordination } from '../realtime/coordination'
import { conflictKey, type Radar, type RadarService } from '../coord/radar'
import { describe } from '../coord/engine'

/** at most one radar test-merge per this interval while an agent writes */
const RADAR_THROTTLE_MS = 4000

/** how long a guarded action waits for a teammate before it lapses to "denied" */
export const APPROVAL_WINDOW_MS = 120_000

/** a turn's lease outlives any sane turn; a crashed instance frees it on expiry */
const TURN_LEASE_MS = 15 * 60_000

type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

/** thoughtPayload's schema bound — a runaway reasoning stretch is truncated, never rejected */
const MAX_THOUGHT_CHARS = 12_000

function capThought(text: string): string {
  return text.length > MAX_THOUGHT_CHARS ? text.slice(0, MAX_THOUGHT_CHARS - 1) + '…' : text
}

export interface TurnStartResult {
  ok: boolean
  error?: string
  /** resolves when the whole turn (including auto-commit) is finished */
  done?: Promise<void>
}

/**
 * The provider-agnostic turn loop — the heart of the app.
 *
 * user_message → status:thinking → stream deltas → tool calls executed in the
 * session worktree → assistant_message → per-file diffs → auto-commit on the
 * session branch → change row + commit event → status:idle.
 *
 * One turn at a time per session; concurrent messages are rejected with a
 * clear error for the caller to surface.
 */
export class AgentOrchestrator {
  /** sessionId → the check run in flight (joined, never duplicated) */
  private checkRuns = new Map<string, Promise<EventPayloadOf<'check_run'>>>()
  /** sessionId → controller for the in-flight turn (present only while running). */
  private aborters = new Map<string, AbortController>()
  /**
   * C3 — per-session transcript snapshots so each turn folds only the tail.
   * In-memory (single instance); a cold start simply refolds from zero.
   */
  private transcriptSnapshots = new Map<
    string,
    {
      upToSeq: number
      entries: import('@loom/shared').TranscriptEntry[]
      brief: import('@loom/shared').SessionBrief
      assistantTurns: number
    }
  >()

  /** Drop a session's snapshot (fork/end keep memory bounded). */
  dropSnapshot(sessionId: string): void {
    this.transcriptSnapshots.delete(sessionId)
  }

  constructor(
    private deps: {
      dbh: DbHandle
      config: ServerConfig
      sessions: SessionService
      projects: ProjectService
      runtime: AgentRuntime
      coord: Coordination
      radar: RadarService
    },
  ) {}

  private turnKey = (sessionId: string) => `turn:${sessionId}`
  private stopKey = (sessionId: string) => `stop:${sessionId}`

  /** this instance is running the session's turn (its checkout here holds the live edits) */
  hasLocalTurn(sessionId: string): boolean {
    return this.aborters.has(sessionId)
  }

  /** any instance may be running this session's turn — the lease says which */
  async isBusy(sessionId: string): Promise<boolean> {
    return (await this.deps.coord.get(this.turnKey(sessionId))) !== null
  }

  /**
   * Interrupt the in-flight turn. The provider stops at its next safe point;
   * runTurn then commits whatever landed on disk and marks the session idle
   * with a "Stopped by driver" note. Only the driver may stop. The turn may be
   * running on another instance, so the request travels through coordination.
   */
  async stopTurn(sessionId: string, user: UserRow): Promise<{ ok: boolean; error?: string }> {
    const session = await this.deps.sessions.getSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.driverUserId !== user.id) return { ok: false, error: 'Only the driver can stop the agent' }
    const local = this.aborters.get(sessionId)
    if (local) {
      local.abort()
      return { ok: true }
    }
    if (!(await this.isBusy(sessionId))) return { ok: false, error: 'The agent is not working right now' }
    await this.deps.coord.set(this.stopKey(sessionId), '1', 60_000)
    return { ok: true }
  }

  /**
   * Mid-run steering. The message is recorded at once (everyone sees it) and
   * handed to the agent at the next tool-call boundary — never mid-edit, so a
   * file is never half-written under a changed instruction. A steer still
   * waiting when the turn ends becomes the next turn's request. The log is the
   * queue: a steer is pending until a `steer_applied` names it.
   */
  async steer(sessionId: string, user: UserRow, text: string): Promise<{ ok: boolean; error?: string }> {
    const session = await this.deps.sessions.getSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.status === 'ended') return { ok: false, error: 'This session has ended' }
    if (session.driverUserId !== user.id) return { ok: false, error: 'Only the driver can steer the agent' }
    if (!(await this.isBusy(sessionId))) return { ok: false, error: 'The agent is not working right now — send a normal message' }
    await this.deps.sessions.appendEvent(sessionId, 'steer', { steerId: ulid(), text, byUserId: user.id, byName: user.name })
    return { ok: true }
  }

  private async pendingSteers(sessionId: string, afterSeq: number): Promise<Array<{ steerId: string; text: string; byName: string }>> {
    const events = await this.deps.sessions.getEvents(sessionId, afterSeq)
    const applied = new Set(events.flatMap((e) => (e.type === 'steer_applied' ? [e.payload.steerId] : [])))
    return events.flatMap((e) => (e.type === 'steer' && !applied.has(e.payload.steerId) ? [{ steerId: e.payload.steerId, text: e.payload.text, byName: e.payload.byName }] : []))
  }

  /** Drain pending steers into the model-facing tool result, recording delivery. */
  private async deliverSteers(sessionId: string, afterSeq: number, afterTool: string): Promise<string> {
    const queue = await this.pendingSteers(sessionId, afterSeq)
    if (queue.length === 0) return ''
    for (const s of queue) await this.deps.sessions.appendEvent(sessionId, 'steer_applied', { steerId: s.steerId, afterTool })
    return (
      '\n\n[STEERING — sent by the driver while you were working. Before your next action, say in one sentence how you read it and how your plan changes; then follow it. Never revert edits the team made.]\n' +
      queue.map((s) => `${s.byName}: ${s.text}`).join('\n')
    )
  }

  async handleUserMessage(
    sessionId: string,
    user: UserRow,
    text: string,
    opts?: { suggestedBy?: { userId: string; name: string } },
  ): Promise<TurnStartResult> {
    const { sessions, coord } = this.deps
    const session = await sessions.getSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.status === 'ended') return { ok: false, error: 'This session has ended' }
    if (session.driverUserId !== user.id) {
      return { ok: false, error: 'Only the driver can send messages — fork the session to continue it yourself' }
    }
    if (!(await coord.acquire(this.turnKey(sessionId), TURN_LEASE_MS))) {
      return { ok: false, error: 'The agent is still working on the previous message — wait for it to finish' }
    }
    // steers recorded from this moment on belong to this turn
    const startSeq = await sessions.lastSeq(sessionId)
    const aborter = new AbortController()
    this.aborters.set(sessionId, aborter)
    // a stop request may arrive at another instance: watch for it
    const stopWatch = setInterval(() => {
      void coord.get(this.stopKey(sessionId)).then(async (v) => {
        if (v && !aborter.signal.aborted) {
          await coord.del(this.stopKey(sessionId))
          aborter.abort()
        }
      })
    }, 750)
    const done = this.finishTurn(session, user, text, aborter, startSeq, opts?.suggestedBy).finally(() => clearInterval(stopWatch))
    // serverless: keep the instance alive until the turn is done
    keepAlive(done)
    return { ok: true, done }
  }

  /**
   * Runs the turn, then emits the TERMINAL status event only AFTER the session
   * lease is released. This ordering matters: the client's queued composer
   * auto-dispatches on the terminal idle/error event, and if the session were
   * still marked "running" at that instant (e.g. during the git commit on the
   * error tail) the dispatched message would be rejected and silently dropped.
   */
  private async finishTurn(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    user: UserRow,
    text: string,
    aborter: AbortController,
    startSeq: number,
    suggestedBy?: { userId: string; name: string },
  ): Promise<void> {
    const { sessions, coord } = this.deps
    const startedAt = Date.now()
    turnLog.info({ sessionId: session.id, driver: user.name }, 'turn start')
    let outcome: { status: 'idle' | 'error'; note?: string } = { status: 'idle' }
    try {
      outcome = await this.runTurn(session, user, text, aborter.signal, startSeq, suggestedBy)
    } catch (err) {
      console.error(`[agent] turn failed for session ${session.id}:`, err)
      outcome = {
        status: 'error',
        note: `The agent hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      // the server can now accept the next message — release BEFORE the
      // terminal event so a queued client dispatch isn't rejected in the tail
      this.aborters.delete(session.id)
      await coord.del(this.turnKey(session.id)).catch(() => {})
      await coord.del(this.stopKey(session.id)).catch(() => {})
    }
    // steers that never met a tool boundary (or arrived after the last one)
    const leftover = aborter.signal.aborted ? [] : await this.pendingSteers(session.id, startSeq).catch(() => [])

    turnLog.info(
      { sessionId: session.id, ms: Date.now() - startedAt, outcome: outcome.status, aborted: aborter.signal.aborted },
      'turn end',
    )
    await sessions.setSessionRowStatus(session.id, 'idle')
    const terminal: EventPayloadOf<'status'> = aborter.signal.aborted
      ? { status: 'idle', note: 'Stopped by driver' }
      : outcome.status === 'error'
        ? { status: 'error', note: outcome.note }
        : { status: 'idle' }
    await sessions.appendEvent(session.id, 'status', terminal).catch(() => {})
    if (leftover.length > 0) {
      const next = await this.handleUserMessage(session.id, user, leftover.map((s) => s.text).join('\n\n'))
      if (next.ok) {
        for (const s of leftover) await sessions.appendEvent(session.id, 'steer_applied', { steerId: s.steerId, afterTool: null }).catch(() => {})
        await next.done
      }
    }
  }

  private async runTurn(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    user: UserRow,
    text: string,
    signal: AbortSignal,
    startSeq: number,
    suggestedBy?: { userId: string; name: string },
  ): Promise<{ status: 'idle' | 'error'; note?: string }> {
    const { sessions, projects, runtime } = this.deps
    const provider = runtime.provider
    const summarizer = runtime.summarizer
    // snapshot the provider identity at turn START — a key pasted mid-turn
    // hot-swaps runtime.mode/model, but THIS turn ran on the provider above,
    // so its usage must be attributed (and priced) to that provider
    const turnMode = runtime.mode
    const turnModel = runtime.model
    const module = await projects.getModule(session.moduleId)
    const project = await projects.getProject(session.projectId)
    if (!module || !project) throw new Error('Module or project missing')

    await sessions.setSessionRowStatus(session.id, 'active')
    const userEvent = await sessions.appendEvent(session.id, 'user_message', {
      text,
      ...(suggestedBy ? { suggestedByName: suggestedBy.name, suggestedByUserId: suggestedBy.userId } : {}),
    })
    await sessions.appendEvent(session.id, 'status', { status: 'thinking' })

    // C3 — transcript snapshot: fold only the events since the last snapshot
    // instead of replaying the whole log every turn. O(snapshot + tail);
    // integrity (fold(snap, tail) === fold(∅, all)) is covered by tests.
    // History is everything BEFORE this turn's request: providers append the
    // request themselves, so folding it into the transcript sent it twice.
    const snap = this.transcriptSnapshots.get(session.id)
    const afterSeq = snap?.upToSeq ?? 0
    const userSeq = userEvent.seq ?? Number.MAX_SAFE_INTEGER
    const history = (await sessions.getEvents(session.id, afterSeq)).filter((e) => (e.seq ?? 0) < userSeq)
    const transcript = foldTranscript(snap?.entries ?? [], history)
    const historyBrief = foldBrief(snap?.brief ?? null, history)
    // the request itself still counts toward the brief (on turn 1 it IS the goal)
    const brief = foldBrief(historyBrief, [userEvent])
    const lastSeq = history.length > 0 ? (history[history.length - 1]!.seq ?? afterSeq) : afterSeq
    const assistantTurns = (snap?.assistantTurns ?? 0) + countAssistantTurns(history)
    // bound the cache: evict the oldest-inserted snapshot past 200 sessions
    if (!snap && this.transcriptSnapshots.size >= 200) {
      const oldest = this.transcriptSnapshots.keys().next().value
      if (oldest) this.transcriptSnapshots.delete(oldest)
    }
    this.transcriptSnapshots.set(session.id, { upToSeq: lastSeq, entries: transcript, brief: historyBrief, assistantTurns })

    // serverless: this instance may never have seen the session's files yet
    await projects.gitFor(project).ensureCheckout(session.worktreePath)
    const tools = new ToolExecutor(session.worktreePath)
    // coordination: brief the agent on teammates' work, and keep telling it about new conflicts
    const coordination = await this.coordinationBriefing(session, project.id).catch(() => null)
    let lastRadarAt = 0
    let announcedTools = false
    // the agent verified its final working tree this turn → skip the automatic post-commit run
    let checkedThisTurn = false

    const ctx: AgentTurnContext = {
      sessionId: session.id,
      projectName: project.name,
      moduleName: module.name,
      moduleDescription: module.description,
      driverName: user.name,
      userMessage: text,
      transcript,
      brief,
      fileTree: tools.listTree(),
      turnIndex: assistantTurns,
      coordination: coordination ?? undefined,
      signal,
      executeTool: async (name, input) => {
        const toolStart = Date.now()
        if (name === 'run_checks') this.announceChecks(session.id, 'agent', 'Agent')
        // the room's rules are enforced here, at the tool call — not in the prompt
        const blocked = await this.guard(session, project.id, name, input, signal)
        const execution = blocked ?? (await tools.execute(name, input))
        turnLog.debug({ sessionId: session.id, tool: name, ms: Date.now() - toolStart, ok: execution.ok }, 'tool')
        await sessions.appendEvent(session.id, 'tool_result', {
          toolName: name,
          summary: execution.summary,
          ok: execution.ok,
          detail: execution.detail,
        })
        // structured outcomes become first-class events the whole room renders
        if (WRITE_TOOLS.has(name)) checkedThisTurn = false
        if (execution.artifact?.kind === 'check_run') {
          checkedThisTurn = true
          const { kind: _kind, ...run } = execution.artifact
          await sessions.appendEvent(session.id, 'check_run', { runId: ulid(), trigger: 'agent', byName: 'Agent', ...run })
        } else if (execution.artifact?.kind === 'plan') {
          await sessions.appendEvent(session.id, 'plan', { steps: execution.artifact.steps })
        } else if (execution.artifact?.kind === 'test_plan') {
          await sessions.appendEvent(session.id, 'test_plan', {
            planId: ulid(),
            cases: execution.artifact.cases.map((c, i) => ({ id: `t${i + 1}`, ...c })),
          })
        }
        // safe point: the tool finished, so mid-run steering can land now
        let extra = ''
        if (!signal.aborted) extra += await this.deliverSteers(session.id, startSeq, name)
        // a write may have just collided with a teammate's work: test-merge (throttled) and tell the agent now
        if (!signal.aborted && WRITE_TOOLS.has(name) && execution.ok && Date.now() - lastRadarAt > RADAR_THROTTLE_MS) {
          lastRadarAt = Date.now()
          extra += await this.coordinationCheck(session, project.id).catch(() => '')
        }
        if (extra) return { ...execution, content: (execution.content ?? execution.summary) + extra }
        return execution
      },
    }

    let errorNote: string | undefined
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    // visible reasoning arrives as deltas; it is persisted as one `thought`
    // per stretch, flushed when the agent moves on to its next action
    let thinking = ''
    const flushThought = async () => {
      const text = thinking.trim()
      thinking = ''
      if (text) await sessions.appendEvent(session.id, 'thought', { text: capThought(text) })
    }
    try {
      for await (const item of provider.runTurn(ctx)) {
        if (item.kind === 'thinking') {
          thinking += item.text
          sessions.publishTransient(session.id, 'thinking_delta', { text: item.text })
          continue
        }
        if (item.kind !== 'usage') await flushThought()
        switch (item.kind) {
          case 'delta':
            sessions.publishTransient(session.id, 'assistant_delta', { text: item.text })
            break
          case 'tool_call':
            if (!announcedTools) {
              announcedTools = true
              await sessions.appendEvent(session.id, 'status', { status: 'running_tools' })
            }
            await sessions.appendEvent(session.id, 'tool_call', { toolName: item.name, input: item.input })
            break
          case 'message_done':
            if (item.fullText.trim()) {
              await sessions.appendEvent(session.id, 'assistant_message', { text: item.fullText })
            }
            break
          case 'usage':
            inputTokens += item.inputTokens
            outputTokens += item.outputTokens
            cacheReadTokens += item.cacheReadTokens ?? 0
            cacheWriteTokens += item.cacheWriteTokens ?? 0
            break
          case 'error':
            // captured, not appended here — the terminal status is emitted by
            // finishTurn AFTER the session is released, so the client's queued
            // dispatch (which fires on that status) is never rejected
            errorNote = item.message
            break
        }
      }
    } catch (err) {
      // an abort surfaces here as the stream throws — swallow it (handled
      // below); anything else is a real failure and re-thrown to the caller
      if (!signal.aborted) throw err
    } finally {
      // reasoning that preceded a stop or an error still belongs in the log
      await flushThought()
    }

    // record token usage + estimated cost for the turn (even a stopped one)
    if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheWriteTokens > 0) {
      await sessions.appendEvent(session.id, 'usage', {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costUsd: estimateCostUsd(turnMode, turnModel, inputTokens, outputTokens, { cacheReadTokens, cacheWriteTokens }),
        model: turnModel,
        provider: turnMode,
      })
    }

    // commit whatever the agent managed to write, even on a stop
    const committed = await this.commitIfDirty(session, module, project, user, text)
    // conflicts this session was told about that now merge cleanly are resolved — "caught before merge"
    await this.coordinationSettle(session, project.id).catch(() => {})
    // every commit gets the shared smoke test (static checks only: no agent code runs unasked)
    if (committed && !checkedThisTurn) await this.runChecksFor(session.id, session.worktreePath, 'commit', 'Loom', { runTests: false })

    return errorNote ? { status: 'error', note: errorNote } : { status: 'idle' }
  }

  private async commitIfDirty(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    module: NonNullable<Awaited<ReturnType<ProjectService['getModule']>>>,
    project: NonNullable<Awaited<ReturnType<ProjectService['getProject']>>>,
    user: UserRow,
    userMessage: string,
  ): Promise<boolean> {
    const { sessions, projects, runtime } = this.deps
    const summarizer = runtime.summarizer
    const git = projects.gitFor(project)
    if (!(await git.isDirty(session.worktreePath))) return false

    await git.stageAll(session.worktreePath)
    const diffs = await git.stagedDiffs(session.worktreePath)
    if (diffs.length === 0) return false

    for (const diff of diffs) {
      await sessions.appendEvent(session.id, 'file_change', {
        path: diff.path,
        changeKind: diff.changeKind,
        unifiedDiff: diff.unifiedDiff,
        additions: diff.additions,
        deletions: diff.deletions,
      })
    }

    const { technicalSummary, plainExplanation } = await summarizer.summarize({
      projectName: project.name,
      moduleName: module.name,
      driverName: user.name,
      userMessage,
      diffs,
    })

    const sha = await git.commit(session.worktreePath, technicalSummary, {
      name: user.name,
      email: user.email,
    })

    const change = await projects.insertChange({
      projectId: project.id,
      sessionId: session.id,
      commitSha: sha,
      branchName: session.branchName,
      technicalSummary,
      plainExplanation,
      filesChanged: diffs.map((d) => ({
        path: d.path,
        changeKind: d.changeKind,
        additions: d.additions,
        deletions: d.deletions,
      })),
      authorUserId: user.id,
    })

    await sessions.appendEvent(session.id, 'commit', {
      changeId: change.id,
      commitSha: sha,
      technicalSummary,
      plainExplanation,
    })

    const [summary] = await projects.toChangeSummaries([change])
    if (summary) {
      sessions.publishProjectUpdate(project.id, { kind: 'change', change: summary })
    }
    return true
  }

  /**
   * Freeze, guarded actions and protected paths. A frozen project refuses every
   * write. A destructive call (delete, shell) or a write to a protected path
   * waits for a second member's decision — never the driver's own — and lapses
   * to "denied" after two minutes. Returns the blocked result, or null to run.
   */
  private async guard(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    projectId: string,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentToolExecution | null> {
    if (!WRITE_TOOLS.has(name)) return null
    const { projects, sessions } = this.deps
    const policy = await projects.getPolicy(projectId)
    if (policy.frozen) {
      return {
        summary: `Blocked — ${policy.frozenBy ?? 'a teammate'} froze this project`,
        ok: false,
        content:
          'The project is frozen: no file changes or commands are allowed until a teammate unfreezes it. Do not retry. Tell the driver what you would have changed.',
      }
    }
    const filePath = typeof input.path === 'string' ? input.path : ''
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    let ask: { summary: string; reason: 'destructive' | 'protected_path' } | null = null
    if (name === 'delete_file') ask = { summary: `delete ${filePath || 'a file'}`, reason: 'destructive' }
    else if (name === 'run_command' && !/^(ls|cat)(\s|$)/.test(command)) ask = { summary: `run \`${command.slice(0, 120)}\``, reason: 'destructive' }
    else if (filePath && matchesProtected(filePath, policy.protectedPaths)) ask = { summary: `change protected file ${filePath}`, reason: 'protected_path' }
    if (!ask || !policy.guardedActions) return null
    // nobody else to ask on a one-person project
    if ((await projects.memberCount(projectId)) <= 1) return null

    const requestId = ulid()
    const deadline = Date.now() + APPROVAL_WINDOW_MS
    const request = await sessions.appendEvent(session.id, 'approval_request', {
      requestId,
      toolName: name,
      summary: ask.summary,
      reason: ask.reason,
      driverUserId: session.driverUserId,
      expiresAt: new Date(deadline).toISOString(),
    })
    let decision: EventPayloadOf<'approval_decision'> | null = null
    while (!signal.aborted && Date.now() < deadline) {
      const after = await sessions.getEvents(session.id, request.seq ?? 0)
      const hit = after.find((e) => e.type === 'approval_decision' && e.payload.requestId === requestId)
      if (hit && hit.type === 'approval_decision') {
        decision = hit.payload
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!decision) {
      decision = { requestId, decision: 'expired', byUserId: null, byName: 'Nobody' }
      await sessions.appendEvent(session.id, 'approval_decision', decision)
    }
    if (decision.decision === 'approved') return null
    return {
      summary: decision.decision === 'expired' ? `Not approved in time: ${ask.summary}` : `${decision.byName} denied: ${ask.summary}`,
      ok: false,
      content:
        decision.decision === 'expired'
          ? `No teammate approved "${ask.summary}" in time, so it did not run. Don't retry it; finish what you can without it and tell the driver.`
          : `${decision.byName} reviewed "${ask.summary}" and denied it, so it did not run. Don't retry it; find another way or ask the driver.`,
    }
  }

  // ------------------------------------------------------------ coordination
  /** conflict keys this session was told about that aren't resolved yet */
  private async openConflicts(sessionId: string): Promise<Map<string, EventPayloadOf<'coordination'>>> {
    const open = new Map<string, EventPayloadOf<'coordination'>>()
    for (const e of await this.deps.sessions.getEvents(sessionId, 0)) {
      if (e.type !== 'coordination') continue
      if (e.payload.kind === 'conflict') open.set(e.payload.key, e.payload)
      if (e.payload.kind === 'resolved') open.delete(e.payload.key)
    }
    return open
  }

  /** record a conflict in this session's log — and the other session's, so both rooms (and agents) know */
  private async recordConflicts(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    radar: Radar,
    found: ReturnType<RadarService['briefingFor']>['conflicts'],
  ): Promise<string[]> {
    const me = radar.items.find((i) => i.key === `session:${session.id}`)
    if (!me) return []
    const open = await this.openConflicts(session.id)
    const told: string[] = []
    for (const c of found) {
      const otherKey = c.other?.key ?? 'main'
      const key = conflictKey(me.key, otherKey, c.items)
      if (open.has(key)) continue
      const items = c.items.slice(0, 20).map((i) => ({ path: i.path, symbols: i.symbols.slice(0, 12) }))
      await this.deps.sessions.appendEvent(session.id, 'coordination', {
        kind: 'conflict',
        key,
        against: c.against,
        withSessionId: c.other?.sessionId ?? null,
        withName: c.other?.userName ?? 'main',
        withBranch: c.other?.branchName ?? 'main',
        items,
      })
      if (c.other?.sessionId) {
        const theirs = await this.openConflicts(c.other.sessionId)
        if (!theirs.has(key)) {
          await this.deps.sessions.appendEvent(c.other.sessionId, 'coordination', {
            kind: 'conflict',
            key,
            against: 'session',
            withSessionId: session.id,
            withName: me.userName,
            withBranch: me.branchName,
            items,
          })
        }
      }
      told.push(
        `${c.other ? `${c.other.userName}'s work (branch ${c.other.branchName})` : 'what is already merged into main'}: ${c.items.map((i) => describe(i.path, i.symbols)).join('; ')}`,
      )
    }
    return told
  }

  private async coordinationBriefing(session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>, projectId: string): Promise<string | null> {
    const radar = await this.deps.radar.forProject(projectId, { fresh: true })
    const key = `session:${session.id}`
    const b = this.deps.radar.briefingFor(radar, key)
    if (!b.text) return null
    const me = radar.items.find((i) => i.key === key)
    const others = radar.overlaps.filter((o) => o.a === key || o.b === key)
    for (const o of others.slice(0, 3)) {
      const other = radar.items.find((i) => i.key === (o.a === key ? o.b : o.a))
      if (!other || !me) continue
      await this.deps.sessions.appendEvent(session.id, 'coordination', {
        kind: 'briefing',
        key: conflictKey(key, other.key, []),
        against: other.kind === 'external' ? 'external' : 'session',
        withSessionId: other.sessionId,
        withName: other.userName,
        withBranch: other.branchName,
        items: o.files.slice(0, 20).map((p) => ({ path: p, symbols: (other.changes.find((c) => c.path === p)?.symbols ?? []).slice(0, 12) })),
      })
    }
    await this.recordConflicts(session, radar, b.conflicts)
    return b.text
  }

  /** after a write: a NEW conflict is told to the agent at this tool boundary */
  private async coordinationCheck(session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>, projectId: string): Promise<string> {
    const radar = await this.deps.radar.forProject(projectId, { fresh: true })
    const { conflicts } = this.deps.radar.briefingFor(radar, `session:${session.id}`)
    const told = await this.recordConflicts(session, radar, conflicts)
    if (told.length === 0) return ''
    return (
      '\n\n[COORDINATION — a test-merge found your change conflicts with ' +
      told.join(' and ') +
      '. Adapt now while it is small: keep both intents, prefer a different function/rule, never undo their work, and say in one line what you changed to fit.]'
    )
  }

  /** after the turn's commit: reported conflicts that now merge cleanly become "resolved" */
  private async coordinationSettle(session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>, projectId: string): Promise<void> {
    const open = await this.openConflicts(session.id)
    if (open.size === 0) return
    const radar = await this.deps.radar.forProject(projectId, { fresh: true })
    const key = `session:${session.id}`
    const me = radar.items.find((i) => i.key === key)
    const live = new Set(
      this.deps.radar.briefingFor(radar, key).conflicts.map((c) => conflictKey(key, c.other?.key ?? 'main', c.items)),
    )
    for (const [k, c] of open) {
      if (live.has(k)) continue
      const resolved = { ...c, kind: 'resolved' as const }
      await this.deps.sessions.appendEvent(session.id, 'coordination', resolved)
      if (c.withSessionId) {
        const theirs = await this.openConflicts(c.withSessionId)
        if (theirs.has(k)) {
          await this.deps.sessions.appendEvent(c.withSessionId, 'coordination', {
            ...theirs.get(k)!,
            kind: 'resolved',
            withName: me?.userName ?? theirs.get(k)!.withName,
          })
        }
      }
    }
  }

  /** Transient "checks running" so every viewer shows the run as it starts. */
  private announceChecks(sessionId: string, trigger: 'commit' | 'manual' | 'agent', byName: string): string {
    const runId = ulid()
    this.deps.sessions.publishTransient(sessionId, 'check_started', { runId, trigger, byName })
    return runId
  }

  /**
   * A check run the whole session watches — after commits, or on demand by
   * any member. One run per session at a time; a concurrent request joins the
   * run already in flight instead of starting a second.
   */
  async runChecksFor(
    sessionId: string,
    worktreePath: string,
    trigger: 'commit' | 'manual' | 'agent',
    byName: string,
    opts: { runTests?: boolean } = {},
  ): Promise<EventPayloadOf<'check_run'>> {
    const inFlight = this.checkRuns.get(sessionId)
    if (inFlight) return inFlight
    const runId = this.announceChecks(sessionId, trigger, byName)
    const job = (async () => {
      // serverless functions have no npm toolchain: static checks only there
      const run = await runChecks(worktreePath, { runTests: this.deps.config.platform === 'serverless' ? false : (opts.runTests ?? true) })
      const payload: EventPayloadOf<'check_run'> = { runId, trigger, byName, ...run }
      await this.deps.sessions.appendEvent(sessionId, 'check_run', payload)
      return payload
    })()
    this.checkRuns.set(sessionId, job)
    try {
      return await job
    } finally {
      this.checkRuns.delete(sessionId)
    }
  }
}
