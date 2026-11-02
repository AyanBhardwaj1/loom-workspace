import type { SessionEvent, SessionEventOf } from '@loom/shared'

/**
 * Pure (non-component) helpers for the event stream. Kept out of EventRow.tsx
 * so that file exports only React components — a requirement for Vite's Fast
 * Refresh to hot-update the stream UI without a full reload.
 *
 * The event log is the source of truth; toDisplayItems turns it into chat UI:
 * tool_call/tool_result pairs merge into one chip, noisy status/usage events
 * are dropped, everything else becomes a rich row.
 */

export type DisplayItem =
  | { kind: 'user'; event: SessionEventOf<'user_message'> }
  | { kind: 'assistant'; event: SessionEventOf<'assistant_message'> }
  | { kind: 'thought'; event: SessionEventOf<'thought'> }
  | { kind: 'tool'; call: SessionEventOf<'tool_call'>; result: SessionEventOf<'tool_result'> | null }
  | { kind: 'file'; event: SessionEventOf<'file_change'> }
  | { kind: 'commit'; event: SessionEventOf<'commit'> }
  | { kind: 'note'; event: SessionEventOf<'status'> }
  | { kind: 'fork'; event: SessionEventOf<'fork_marker'> }
  | { kind: 'checks'; event: SessionEventOf<'check_run'> }
  | { kind: 'plan'; event: SessionEventOf<'plan'> }
  /** mid-run steer; afterTool = where it landed (undefined = still waiting) */
  | { kind: 'steer'; event: SessionEventOf<'steer'>; applied: { afterTool: string | null } | undefined }
  | { kind: 'tests'; event: SessionEventOf<'test_plan'>; verdicts: Array<SessionEventOf<'test_verdict'>> }
  | { kind: 'approval'; event: SessionEventOf<'approval_request'>; decision: SessionEventOf<'approval_decision'> | null }
  | { kind: 'coordination'; event: SessionEventOf<'coordination'> }
  | {
      kind: 'suggestion'
      event: SessionEventOf<'suggestion'>
      decision: 'accepted' | 'dismissed' | null
    }

export interface RowActions {
  /** current viewer is the session driver (can accept/dismiss suggestions) */
  isDriver?: boolean
  onResolveSuggestion?: (suggestionId: string, decision: 'accepted' | 'dismissed') => void
  /** lets rows link into the project (fork markers → the forked session) */
  projectId?: string
  /** F4: open the evolution player at the log root (survives row recycling) */
  onPlayEvolution?: (path: string, steps: string[]) => void
  /** record a pass/fail verdict on one of the agent's test cases */
  onVerdict?: (planId: string, caseId: string, verdict: 'pass' | 'fail', note?: string) => Promise<void>
  /** a teammate approves or denies a guarded agent action */
  onApproval?: (requestId: string, decision: 'approved' | 'denied') => Promise<void>
  /** the viewer's user id (the driver can't approve their own run) */
  selfId?: string
  /** seq of the latest commit — verdicts before it are stale */
  latestCommitSeq?: number
  /** open the shared test bench (to try the cases in the live preview) */
  onOpenBench?: () => void
  /** F8: pin a reaction ('up'|'spark'|'question'|'flag') or comment to an event */
  onAnnotate?: (targetEventId: string, kind: 'reaction' | 'comment', body: string) => void
}

const QUIET_TOOLS = new Set(['run_checks', 'update_plan', 'propose_tests'])

/** each person's latest verdict per case (people change their minds) */
export function latestVerdicts(verdicts: Array<SessionEventOf<'test_verdict'>>): Map<string, Array<SessionEventOf<'test_verdict'>>> {
  const byCaseUser = new Map<string, SessionEventOf<'test_verdict'>>()
  for (const v of verdicts) byCaseUser.set(`${v.payload.caseId}::${v.payload.byUserId}`, v)
  const out = new Map<string, Array<SessionEventOf<'test_verdict'>>>()
  for (const v of byCaseUser.values()) out.set(v.payload.caseId, [...(out.get(v.payload.caseId) ?? []), v])
  return out
}

/** the latest test plan and every verdict recorded against it */
export function latestTests(events: SessionEvent[]): { plan: SessionEventOf<'test_plan'>; verdicts: Array<SessionEventOf<'test_verdict'>> } | null {
  let plan: SessionEventOf<'test_plan'> | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'test_plan') {
      plan = e
      break
    }
  }
  if (!plan) return null
  const id = plan.payload.planId
  return { plan, verdicts: events.filter((e): e is SessionEventOf<'test_verdict'> => e.type === 'test_verdict' && e.payload.planId === id) }
}

/** the most recent plan and check run — the session's "what now / does it work" */
export function latestOf(events: SessionEvent[]): { plan: SessionEventOf<'plan'> | null; checks: SessionEventOf<'check_run'> | null } {
  let plan: SessionEventOf<'plan'> | null = null
  let checks: SessionEventOf<'check_run'> | null = null
  for (let i = events.length - 1; i >= 0 && (!plan || !checks); i--) {
    const e = events[i]!
    if (!plan && e.type === 'plan') plan = e
    if (!checks && e.type === 'check_run') checks = e
  }
  return { plan, checks }
}

export function toDisplayItems(events: SessionEvent[]): DisplayItem[] {
  const items: DisplayItem[] = []
  const openToolChips: Array<Extract<DisplayItem, { kind: 'tool' }>> = []
  // the plan is replaced wholesale on each update: one row per turn, latest state
  let turnPlan: Extract<DisplayItem, { kind: 'plan' }> | null = null
  // decisions may arrive after their suggestion; resolve in a first pass
  const decisions = new Map<string, 'accepted' | 'dismissed'>()
  const applied = new Map<string, { afterTool: string | null }>()
  const approvals = new Map<string, SessionEventOf<'approval_decision'>>()
  const verdictsByPlan = new Map<string, Array<SessionEventOf<'test_verdict'>>>()
  for (const e of events) {
    if (e.type === 'suggestion_decision') decisions.set(e.payload.suggestionId, e.payload.decision)
    if (e.type === 'steer_applied') applied.set(e.payload.steerId, { afterTool: e.payload.afterTool })
    if (e.type === 'approval_decision') approvals.set(e.payload.requestId, e)
    if (e.type === 'test_verdict') verdictsByPlan.set(e.payload.planId, [...(verdictsByPlan.get(e.payload.planId) ?? []), e])
  }
  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        // message boundary: any tool call still unpaired belongs to a segment
        // that never completed (e.g. a fork cut mid-turn) — never let a later
        // segment's result pair with it
        openToolChips.length = 0
        turnPlan = null
        items.push({ kind: 'user', event: e })
        break
      case 'assistant_message':
        openToolChips.length = 0
        items.push({ kind: 'assistant', event: e })
        break
      case 'thought':
        items.push({ kind: 'thought', event: e })
        break
      case 'tool_call': {
        // these two surface as their own rows (checks, plan), not as chips
        if (QUIET_TOOLS.has(e.payload.toolName)) break
        const chip: Extract<DisplayItem, { kind: 'tool' }> = { kind: 'tool', call: e, result: null }
        items.push(chip)
        openToolChips.push(chip)
        break
      }
      case 'tool_result': {
        const idx = openToolChips.findIndex((c) => c.result === null && c.call.payload.toolName === e.payload.toolName)
        if (idx >= 0) {
          openToolChips[idx]!.result = e
          openToolChips.splice(idx, 1)
        }
        break
      }
      case 'file_change':
        items.push({ kind: 'file', event: e })
        break
      case 'commit':
        items.push({ kind: 'commit', event: e })
        break
      case 'status':
        if (e.payload.status === 'error' || (e.payload.note && e.payload.status !== 'thinking' && e.payload.status !== 'running_tools')) {
          items.push({ kind: 'note', event: e })
        }
        break
      case 'check_run':
        items.push({ kind: 'checks', event: e })
        break
      case 'steer':
        items.push({ kind: 'steer', event: e, applied: applied.get(e.payload.steerId) })
        break
      case 'test_plan':
        items.push({ kind: 'tests', event: e, verdicts: verdictsByPlan.get(e.payload.planId) ?? [] })
        break
      case 'coordination':
        items.push({ kind: 'coordination', event: e })
        break
      case 'approval_request':
        items.push({ kind: 'approval', event: e, decision: approvals.get(e.payload.requestId) ?? null })
        break
      case 'steer_applied':
      case 'approval_decision':
      case 'test_verdict':
        // folded into their steer / test plan rows above
        break
      case 'plan':
        if (turnPlan) turnPlan.event = e
        else {
          turnPlan = { kind: 'plan', event: e }
          items.push(turnPlan)
        }
        break
      case 'fork_marker':
        items.push({ kind: 'fork', event: e })
        break
      case 'suggestion':
        items.push({ kind: 'suggestion', event: e, decision: decisions.get(e.payload.suggestionId) ?? null })
        break
      case 'suggestion_decision':
        // folded into its suggestion item above
        break
      case 'usage':
        // metadata for the cost chip, not a chat row
        break
      case 'annotation':
        // F8: attaches under its target event (ChatLog groups them)
        break
      default:
        break
    }
  }
  return items
}
