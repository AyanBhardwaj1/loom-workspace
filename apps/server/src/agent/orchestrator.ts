import type { AgentTurnContext } from '@loom/shared'
import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import type { ProjectService } from '../projects/service'
import type { SessionService } from '../sessions/service'
import { agentSystemPrompt, buildTranscript, countAssistantTurns } from './context'
import { estimateCostUsd } from './pricing'
import type { AgentRuntime } from './runtime'
import { ToolExecutor } from './tools'

type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

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
    const done = this.runTurn(session, user, text, aborter.signal, opts?.suggestedBy)
      .catch(async (err) => {
        console.error(`[agent] turn failed for session ${sessionId}:`, err)
        await sessions
          .appendEvent(sessionId, 'status', {
            status: 'error',
            note: `The agent hit an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
          })
          .catch(() => {})
      })
      .finally(() => {
        this.runningTurns.delete(sessionId)
        this.aborters.delete(sessionId)
      })
    return { ok: true, done }
  }

  private async runTurn(
    session: NonNullable<Awaited<ReturnType<SessionService['getSession']>>>,
    user: UserRow,
    text: string,
    signal: AbortSignal,
    suggestedBy?: { userId: string; name: string },
  ): Promise<void> {
    const { sessions, projects, runtime } = this.deps
    const provider = runtime.provider
    const summarizer = runtime.summarizer
    const module = await projects.getModule(session.moduleId)
    const project = await projects.getProject(session.projectId)
    if (!module || !project) throw new Error('Module or project missing')

    await sessions.setSessionRowStatus(session.id, 'active')
    await sessions.appendEvent(session.id, 'user_message', {
      text,
      ...(suggestedBy ? { suggestedByName: suggestedBy.name, suggestedByUserId: suggestedBy.userId } : {}),
    })
    await sessions.appendEvent(session.id, 'status', { status: 'thinking' })

    const priorEvents = await sessions.getEvents(session.id, 0)
    const tools = new ToolExecutor(session.worktreePath)
    let announcedTools = false

    const ctx: AgentTurnContext = {
      sessionId: session.id,
      projectName: project.name,
      moduleName: module.name,
      moduleDescription: module.description,
      driverName: user.name,
      userMessage: text,
      transcript: buildTranscript(priorEvents),
      fileTree: tools.listTree(),
      turnIndex: countAssistantTurns(priorEvents),
      signal,
      executeTool: async (name, input) => {
        const execution = await tools.execute(name, input)
        await sessions.appendEvent(session.id, 'tool_result', {
          toolName: name,
          summary: execution.summary,
          ok: execution.ok,
          detail: execution.detail,
        })
        return execution
      },
    }

    let sawError = false
    let inputTokens = 0
    let outputTokens = 0
    try {
      for await (const item of provider.runTurn(ctx)) {
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
            break
          case 'error':
            sawError = true
            await sessions.appendEvent(session.id, 'status', { status: 'error', note: item.message })
            break
        }
      }
    } catch (err) {
      // an abort surfaces here as the stream throws — swallow it (handled
      // below); anything else is a real failure and re-thrown to the caller
      if (!signal.aborted) throw err
    }

    // record token usage + estimated cost for the turn (even a stopped one)
    if (inputTokens > 0 || outputTokens > 0) {
      await sessions.appendEvent(session.id, 'usage', {
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(runtime.mode, runtime.model, inputTokens, outputTokens),
        model: runtime.model,
        provider: runtime.mode,
      })
    }

    // commit whatever the agent managed to write, even on a stop
    await this.commitIfDirty(session, module, project, user, text)

    if (signal.aborted) {
      await sessions.appendEvent(session.id, 'status', { status: 'idle', note: 'Stopped by driver' })
    } else if (!sawError) {
      await sessions.appendEvent(session.id, 'status', { status: 'idle' })
    }
    await sessions.setSessionRowStatus(session.id, 'idle')
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
