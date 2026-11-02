import type { SessionEvent, SessionEventOf } from './events'
import { isFreshVerdict, latestCommitSeq } from './mergeGate'

/**
 * What a session is doing right now, DERIVED from its event log — never set
 * by hand, so every viewer (and the Room, and replay) agrees. Modelled on
 * agent-session lifecycles in production tools (working / awaiting input /
 * error / stale), plus the states a multiplayer room cares about.
 */
export type SessionState = 'awaiting-approval' | 'working' | 'checking' | 'needs-testing' | 'your-move' | 'error' | 'idle' | 'stale' | 'ended'

export interface DerivedSessionState {
  state: SessionState
  /** short, human: "editing index.html", "2 tests to try", "asked Ayan a question" */
  detail: string
}

const STALE_MS = 30 * 60 * 1000

export function activityOf(call: SessionEventOf<'tool_call'>): string {
  const input = call.payload.input ?? {}
  const path = typeof input['path'] === 'string' ? (input['path'] as string) : null
  switch (call.payload.toolName) {
    case 'write_file':
      return path ? `writing ${path}` : 'writing a file'
    case 'edit_file':
      return path ? `editing ${path}` : 'editing a file'
    case 'read_file':
      return path ? `reading ${path}` : 'reading a file'
    case 'delete_file':
      return path ? `deleting ${path}` : 'deleting a file'
    case 'list_files':
      return 'looking around the workspace'
    case 'search_files':
      return 'searching the code'
    case 'run_command':
      return typeof input['command'] === 'string' ? `running ${String(input['command']).slice(0, 40)}` : 'running a command'
    case 'run_checks':
      return 'running the team checks'
    case 'update_plan':
      return 'updating its plan'
    case 'propose_tests':
      return 'writing test cases'
    default:
      return `using ${call.payload.toolName}`
  }
}

export function deriveSessionState(input: {
  events: SessionEvent[]
  ended?: boolean
  driverName?: string
  /** a check run is in flight (transient, known only live) */
  checking?: boolean
  now?: number
}): DerivedSessionState {
  const { events, ended, checking } = input
  const now = input.now ?? Date.now()
  if (ended) return { state: 'ended', detail: 'session ended' }
  if (checking) return { state: 'checking', detail: 'running the team checks' }

  let lastStatus: SessionEventOf<'status'> | null = null
  let lastUser = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (!lastStatus && e.type === 'status') lastStatus = e
    if (lastUser < 0 && e.type === 'user_message') lastUser = i
    if (lastStatus && lastUser >= 0) break
  }
  const status = lastStatus?.payload.status ?? 'idle'

  // a guarded action is waiting on a second person — the room's most urgent state
  const decided = new Set(events.flatMap((e) => (e.type === 'approval_decision' ? [e.payload.requestId] : [])))
  const waiting = events.find((e): e is SessionEventOf<'approval_request'> => e.type === 'approval_request' && !decided.has(e.payload.requestId))
  if (waiting && (status === 'thinking' || status === 'running_tools')) return { state: 'awaiting-approval', detail: `needs a teammate to approve: ${waiting.payload.summary}` }

  if (status === 'thinking' || status === 'running_tools') {
    for (let i = events.length - 1; i > lastUser; i--) {
      const e = events[i]!
      if (e.type === 'tool_call') return { state: 'working', detail: activityOf(e) }
    }
    return { state: 'working', detail: 'thinking' }
  }
  if (status === 'error') return { state: 'error', detail: lastStatus?.payload.note ?? 'the agent hit an error' }

  // idle: is anything waiting on the humans?
  let plan: SessionEventOf<'test_plan'> | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'test_plan') {
      plan = e
      break
    }
  }
  if (plan) {
    // a verdict given before the latest commit describes code that has since moved
    const commitSeq = latestCommitSeq(events)
    const tried = new Set(
      events
        .filter((e): e is SessionEventOf<'test_verdict'> => e.type === 'test_verdict' && e.payload.planId === plan!.payload.planId && isFreshVerdict(e, commitSeq))
        .map((e) => e.payload.caseId),
    )
    const open = plan.payload.cases.filter((c) => !tried.has(c.id)).length
    if (open > 0) return { state: 'needs-testing', detail: `${open} test${open === 1 ? '' : 's'} to try` }
  }
  const last = events[events.length - 1]
  for (let i = events.length - 1; i > lastUser; i--) {
    const e = events[i]!
    if (e.type === 'assistant_message') {
      if (/\?\s*$/.test(e.payload.text.trim())) return { state: 'your-move', detail: `asked ${input.driverName ?? 'the driver'} a question` }
      break
    }
  }
  if (last && now - Date.parse(last.createdAt) > STALE_MS) return { state: 'stale', detail: 'quiet for a while' }
  return { state: 'idle', detail: 'ready for the next step' }
}
