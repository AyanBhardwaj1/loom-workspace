import type { AgentTurnContext, EventPayloadOf } from '@loom/shared'
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
  private runningTurns = new Set<string>()
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
    },
  ) {}

  isBusy(sessionId: string): boolean {
    return this.runningTurns.has(sessionId)
  }

  /**
   * Interrupt the in-flight turn. The provider stops at its next safe point;
   * runTurn then commits whatever landed on disk and marks the session idle
   * with a "Stopped by driver" note. Only the driver may stop.
   */
  async stopTurn(sessionId: string, user: UserRow): Promise<{ ok: boolean; error?: string }> {
    const session = await this.deps.sessions.getSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.driverUserId !== user.id) return { ok: false, error: 'Only the driver can stop the agent' }
    const controller = this.aborters.get(sessionId)
    if (!controller) return { ok: false, error: 'The agent is not working right now' }
    controller.abort()
    return { ok: true }
  }

  async handleUserMessage(
    sessionId: string,
    user: UserRow,
    text: string,
    opts?: { suggestedBy?: { userId: string; name: string } },
  ): Promise<TurnStartResult> {
    const { sessions } = this.deps
    const session = await sessions.getSession(sessionId)
    if (!session) return { ok: false, error: 'Session not found' }
    if (session.status === 'ended') return { ok: false, error: 'This session has ended' }
    if (session.driverUserId !== user.id) {
      return { ok: false, error: 'Only the driver can send messages — fork the session to continue it yourself' }
    }
    if (this.runningTurns.has(sessionId)) {
      return { ok: false, error: 'The agent is still working on the previous message — wait for it to finish' }
    }

    this.runningTurns.add(sessionId)
    const aborter = new AbortController()
    this.aborters.set(sessionId, aborter)
    const done = this.finishTurn(session, user, text, aborter, opts?.suggestedBy)
    return { ok: true, done }
  }

  /**
   * Runs the turn, then emits the TERMINAL status event only AFTER the session
   * is released from runningTurns. This ordering matters: the client's queued
   * composer auto-dispatches on the terminal idle/error event, and if the
   * session were still marked "running" at that instant (e.g. during the git
   * commit on the error tail) the dispatched message would be rejected and
   * silently dropped.
   */
  private async finishTurn(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    user: UserRow,
    text: string,
    aborter: AbortController,
    suggestedBy?: { userId: string; name: string },
  ): Promise<void> {
    const { sessions } = this.deps
    const startedAt = Date.now()
    turnLog.info({ sessionId: session.id, driver: user.name }, 'turn start')
    let outcome: { status: 'idle' | 'error'; note?: string } = { status: 'idle' }
    try {
      outcome = await this.runTurn(session, user, text, aborter.signal, suggestedBy)
    } catch (err) {
      console.error(`[agent] turn failed for session ${session.id}:`, err)
      outcome = {
        status: 'error',
        note: `The agent hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      }
    } finally {
      // the server can now accept the next message — release BEFORE the
      // terminal event so a queued client dispatch isn't rejected in the tail
      this.runningTurns.delete(session.id)
      this.aborters.delete(session.id)
    }

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
  }

  private async runTurn(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    user: UserRow,
    text: string,
    signal: AbortSignal,
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

    const tools = new ToolExecutor(session.worktreePath)
    let announcedTools = false

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
      signal,
      executeTool: async (name, input) => {
        const toolStart = Date.now()
        const execution = await tools.execute(name, input)
        turnLog.debug({ sessionId: session.id, tool: name, ms: Date.now() - toolStart, ok: execution.ok }, 'tool')
        await sessions.appendEvent(session.id, 'tool_result', {
          toolName: name,
          summary: execution.summary,
          ok: execution.ok,
          detail: execution.detail,
        })
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
    await this.commitIfDirty(session, module, project, user, text)

    return errorNote ? { status: 'error', note: errorNote } : { status: 'idle' }
  }

  private async commitIfDirty(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    module: NonNullable<Awaited<ReturnType<ProjectService['getModule']>>>,
    project: NonNullable<Awaited<ReturnType<ProjectService['getProject']>>>,
    user: UserRow,
    userMessage: string,
  ): Promise<void> {
    const { sessions, projects, runtime } = this.deps
    const summarizer = runtime.summarizer
    const git = projects.gitFor(project)
    if (!(await git.isDirty(session.worktreePath))) return

    await git.stageAll(session.worktreePath)
    const diffs = await git.stagedDiffs(session.worktreePath)
    if (diffs.length === 0) return

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
  }
}
