import { BRAND, type AgentTurnContext, type SessionBrief, type SessionEvent, type TranscriptEntry } from '@loom/shared'

/**
 * Rebuild a condensed conversation transcript from the persisted event log.
 * This is the model's memory of the session — which is exactly why forking
 * "just works": the copied log reconstructs the same context.
 */
export function buildTranscript(events: SessionEvent[]): TranscriptEntry[] {
  return foldTranscript([], events)
}

export const TRANSCRIPT_KEEP = 60

/**
 * C3 — incremental fold: append the tail's entries to a previous snapshot and
 * trim to the last TRANSCRIPT_KEEP. Trimming keeps suffixes, so
 * fold(fold(∅, A), B) === fold(∅, A ++ B) — the snapshot-integrity property
 * the orchestrator's per-session cache (and its test) rely on.
 */
export function foldTranscript(prev: TranscriptEntry[], events: SessionEvent[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [...prev]
  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        entries.push({ role: 'user', text: cap(e.payload.text, 2000) })
        break
      case 'assistant_message':
        entries.push({ role: 'assistant', text: cap(e.payload.text, 2000) })
        break
      case 'tool_call':
        entries.push({
          role: 'tool',
          text: `→ ${e.payload.toolName}(${cap(JSON.stringify(e.payload.input), 160)})`,
        })
        break
      case 'tool_result':
        entries.push({ role: 'tool', text: `← ${cap(e.payload.summary, 200)}` })
        break
      case 'commit':
        entries.push({ role: 'tool', text: `✓ committed: ${cap(e.payload.technicalSummary, 200)}` })
        break
      default:
        break
    }
  }
  // keep the tail — old context matters less than recent work
  return entries.slice(-TRANSCRIPT_KEEP)
}

/** commits kept in the brief — enough to recall a long session's arc */
export const BRIEF_COMMITS = 30

/**
 * The session's durable memory: its goal (the first request) and the ledger
 * of what has been committed. The transcript tail trims away early turns;
 * the brief never loses them. Suffix-associative like foldTranscript, so the
 * orchestrator can fold it incrementally from the same snapshot.
 */
export function foldBrief(prev: SessionBrief | null, events: SessionEvent[]): SessionBrief {
  let goal = prev?.goal ?? null
  const commits = [...(prev?.commits ?? [])]
  for (const e of events) {
    if (e.type === 'user_message' && goal === null) goal = cap(e.payload.text, 600)
    if (e.type === 'commit') commits.push(cap(e.payload.technicalSummary, 160))
  }
  return { goal, commits: commits.slice(-BRIEF_COMMITS) }
}

export function countAssistantTurns(events: SessionEvent[]): number {
  return events.filter((e) => e.type === 'assistant_message').length
}

/**
 * Stable for the whole session (project, module and driver only), so it is
 * byte-identical across turns and stays in the prompt cache. Anything that
 * changes turn to turn belongs in agentDynamicContext.
 */
export function agentSystemPrompt(input: {
  projectName: string
  moduleName: string
  moduleDescription: string
  driverName: string
}): string {
  return `You are the ${BRAND} coding agent, pair-building the "${input.projectName}" project with ${input.driverName}. You are working in the "${input.moduleName}" module${input.moduleDescription ? ` (${input.moduleDescription})` : ''}.

Your workspace is a git worktree of the project. Every change you make is committed to this session's branch when your turn ends, and teammates watch the session live: your messages, your progress notes between tool calls, and each file change stream to their screens as you work. Write for them in plain language.

How to work:
- Make small, coherent increments; leave the project runnable at the end of every turn.
- Prefer plain HTML/CSS/JS or small Node apps, so the session preview shows the result immediately.
- Use search_files to find code, read a file before editing it, edit_file for targeted changes (old_string must match exactly one place), and write_file for new files or full rewrites.
- Before your first tool call, say in one sentence what you're about to do. When you finish, recap what changed and anything ${input.driverName} should check.`
}

/**
 * Per-turn context that changes as the session progresses. Kept OUT of the
 * stable system prompt so the system block stays byte-identical (cacheable)
 * for the whole session.
 */
export function agentDynamicContext(ctx: Pick<AgentTurnContext, 'fileTree' | 'brief'>): string {
  const sections: string[] = []
  if (ctx.brief?.goal) sections.push(`Session goal (the request that started this session):\n${ctx.brief.goal}`)
  if (ctx.brief && ctx.brief.commits.length > 0) {
    sections.push(`Committed so far, oldest first:\n${ctx.brief.commits.map((c) => `- ${c}`).join('\n')}`)
  }
  sections.push(
    ['Current files in the workspace:', ctx.fileTree.length > 0 ? ctx.fileTree.map((f) => `- ${f}`).join('\n') : '(empty)'].join('\n'),
  )
  return sections.join('\n\n')
}

function cap(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
