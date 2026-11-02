import { z } from 'zod'

/**
 * SessionEvent is the atom of the whole system: an append-only, ordered log
 * entry within a session. The event log is the source of truth — the chat UI,
 * the spectator sidebar, and forking are all just views/copies of this log.
 *
 * Persistence rule: every event type is persisted as a row in `session_events`
 * EXCEPT the stream deltas (`assistant_delta`, `thinking_delta`), which are
 * broadcast-only (transient). When a streamed message completes, one
 * `assistant_message` (or `thought`) is persisted. Transient events carry
 * `seq: null`; persisted events carry a monotonic per-session seq.
 */

/** Live activity status of the agent inside a session (event-level). */
export const agentActivityStatusSchema = z.enum(['thinking', 'running_tools', 'idle', 'error'])
export type AgentActivityStatus = z.infer<typeof agentActivityStatusSchema>

/** Lifecycle status of a session row. */
export const sessionRowStatusSchema = z.enum(['active', 'idle', 'ended'])
export type SessionRowStatus = z.infer<typeof sessionRowStatusSchema>

export const moduleStatusSchema = z.enum(['idea', 'building', 'stable'])
export type ModuleStatus = z.infer<typeof moduleStatusSchema>

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export const userMessagePayload = z.object({
  text: z.string(),
  /** When the driver accepted a spectator's suggestion, credit them here. */
  suggestedByName: z.string().optional(),
  suggestedByUserId: z.string().optional(),
})
export const assistantDeltaPayload = z.object({ text: z.string() })
export const assistantMessagePayload = z.object({ text: z.string() })
/** Live reasoning stream (summarized thinking + between-tool progress notes). */
export const thinkingDeltaPayload = z.object({ text: z.string() })
/** One completed stretch of visible reasoning, persisted so replays show it. */
export const thoughtPayload = z.object({ text: z.string().max(12_000) })
/** A smoke-test run everyone in the session watches: after commits, on demand, or by the agent. */
export const checkTriggerSchema = z.enum(['commit', 'manual', 'agent'])
export const checkResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  detail: z.string().max(2000).optional(),
})
export const checkRunPayload = z.object({
  runId: z.string(),
  trigger: checkTriggerSchema,
  byName: z.string(),
  status: z.enum(['passed', 'warned', 'failed']),
  results: z.array(checkResultSchema).max(20),
  durationMs: z.number().int().nonnegative(),
})
/** The agent's announced plan (intent broadcast) — replaced wholesale on each update. */
export const planStepSchema = z.object({ text: z.string().min(1).max(200), status: z.enum(['todo', 'doing', 'done']) })
export const planPayload = z.object({ steps: z.array(planStepSchema).min(1).max(12) })
/**
 * Mid-run steering: the driver redirects the agent WHILE it works. Delivered
 * at the next tool-call boundary (never mid-edit); `steer_applied` records
 * when the agent actually received it. Humans steer, the agent never does.
 */
export const steerPayload = z.object({
  steerId: z.string(),
  text: z.string().min(1).max(2000),
  byUserId: z.string(),
  byName: z.string(),
})
export const steerAppliedPayload = z.object({
  steerId: z.string(),
  /** the tool whose boundary carried it in; null when it became the next turn */
  afterTool: z.string().nullable(),
})
/** Per-feature acceptance tests the agent proposes; teammates run them in the live preview. */
export const testCaseSchema = z.object({
  id: z.string(),
  action: z.string().min(1).max(200),
  expect: z.string().min(1).max(200),
})
export const testPlanPayload = z.object({ planId: z.string(), cases: z.array(testCaseSchema).min(1).max(8) })
/** A teammate's verdict on one test case — advisory evidence the agent reads next turn. */
export const testVerdictPayload = z.object({
  planId: z.string(),
  caseId: z.string(),
  verdict: z.enum(['pass', 'fail']),
  note: z.string().max(300).optional(),
  byUserId: z.string(),
  byName: z.string(),
})
/**
 * Guarded actions: a destructive tool call (delete, shell, protected path)
 * waits for a second member's decision — the driver can't approve their own.
 */
export const approvalRequestPayload = z.object({
  requestId: z.string(),
  toolName: z.string(),
  /** what the agent wants to do, in plain words ("delete index.html") */
  summary: z.string().max(300),
  reason: z.enum(['destructive', 'protected_path']),
  driverUserId: z.string(),
  /** ISO time the request lapses (denied) if nobody decides */
  expiresAt: z.string(),
})
export const approvalDecisionPayload = z.object({
  requestId: z.string(),
  decision: z.enum(['approved', 'denied', 'expired']),
  byUserId: z.string().nullable(),
  byName: z.string(),
})
/**
 * Agent coordination: what the radar told an agent about other agents' work.
 * `briefing` — at turn start, who else is changing the same files; `conflict` —
 * a test-merge found both changed the same symbol (the agent was told to adapt
 * now, while it's small); `resolved` — a reported conflict now merges cleanly.
 */
export const coordinationPayload = z.object({
  kind: z.enum(['briefing', 'conflict', 'resolved']),
  /** stable signature of the conflict (pair + files + symbols) — pairs `conflict` with `resolved` */
  key: z.string(),
  against: z.enum(['session', 'main', 'external']),
  withSessionId: z.string().nullable(),
  withName: z.string(),
  withBranch: z.string().nullable(),
  items: z.array(z.object({ path: z.string(), symbols: z.array(z.string()).max(12) })).max(20),
})
/** Transient: a check run began (so every viewer shows it running). */
export const checkStartedPayload = z.object({ runId: z.string(), trigger: checkTriggerSchema, byName: z.string() })
export const toolCallPayload = z.object({
  toolName: z.string(),
  input: z.record(z.unknown()),
})
export const toolResultPayload = z.object({
  toolName: z.string(),
  summary: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
})
export const fileChangePayload = z.object({
  path: z.string(),
  changeKind: z.enum(['create', 'edit', 'delete']),
  unifiedDiff: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
})
export const commitPayload = z.object({
  changeId: z.string(),
  commitSha: z.string(),
  technicalSummary: z.string(),
  plainExplanation: z.string(),
})
export const statusPayload = z.object({
  status: agentActivityStatusSchema,
  note: z.string().optional(),
  /** F9 — set when this status records a driver handoff */
  newDriverUserId: z.string().optional(),
  /** who held the wheel before the handoff (attribution of earlier work) */
  previousDriverUserId: z.string().optional(),
  newDriverName: z.string().optional(),
  newDriverColor: z.string().optional(),
})
export const forkMarkerPayload = z.object({
  childSessionId: z.string(),
  byUserName: z.string(),
})
/** A spectator proposes a next step; only the driver can accept it into work. */
export const suggestionPayload = z.object({
  suggestionId: z.string(),
  text: z.string(),
  suggesterUserId: z.string(),
  suggesterName: z.string(),
  suggesterColor: z.string(),
})
/** The driver's resolution of a suggestion (append-only; never mutates the suggestion). */
export const suggestionDecisionPayload = z.object({
  suggestionId: z.string(),
  decision: z.enum(['accepted', 'dismissed']),
  decidedByName: z.string(),
})
/** Token usage + estimated cost for one completed turn (mock fabricates plausible numbers). */
export const usagePayload = z.object({
  /** uncached input */
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** prompt-cache traffic (optional: absent on pre-caching events and non-Claude providers) */
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  model: z.string().nullable(),
  provider: z.string(),
})
/** F8 — a spectator's reaction or comment pinned to an earlier event. */
export const annotationPayload = z.object({
  targetEventId: z.string(),
  authorUserId: z.string(),
  authorName: z.string(),
  authorColor: z.string(),
  kind: z.enum(['reaction', 'comment']),
  /** reaction name ('up' | 'spark' | 'question' | 'flag') or the comment text */
  body: z.string().min(1).max(1000),
})

// ---------------------------------------------------------------------------
// Event envelope (discriminated union on `type`)
// ---------------------------------------------------------------------------

const base = {
  /** ulid — globally unique, lexicographically sortable */
  id: z.string(),
  sessionId: z.string(),
  /** monotonic per-session sequence; null for transient (assistant_delta) events */
  seq: z.number().int().nullable(),
  /** ISO 8601 */
  createdAt: z.string(),
}

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('user_message'), payload: userMessagePayload }),
  z.object({ ...base, type: z.literal('assistant_delta'), payload: assistantDeltaPayload }),
  z.object({ ...base, type: z.literal('assistant_message'), payload: assistantMessagePayload }),
  z.object({ ...base, type: z.literal('thinking_delta'), payload: thinkingDeltaPayload }),
  z.object({ ...base, type: z.literal('thought'), payload: thoughtPayload }),
  z.object({ ...base, type: z.literal('check_started'), payload: checkStartedPayload }),
  z.object({ ...base, type: z.literal('check_run'), payload: checkRunPayload }),
  z.object({ ...base, type: z.literal('plan'), payload: planPayload }),
  z.object({ ...base, type: z.literal('steer'), payload: steerPayload }),
  z.object({ ...base, type: z.literal('steer_applied'), payload: steerAppliedPayload }),
  z.object({ ...base, type: z.literal('test_plan'), payload: testPlanPayload }),
  z.object({ ...base, type: z.literal('approval_request'), payload: approvalRequestPayload }),
  z.object({ ...base, type: z.literal('coordination'), payload: coordinationPayload }),
  z.object({ ...base, type: z.literal('approval_decision'), payload: approvalDecisionPayload }),
  z.object({ ...base, type: z.literal('test_verdict'), payload: testVerdictPayload }),
  z.object({ ...base, type: z.literal('tool_call'), payload: toolCallPayload }),
  z.object({ ...base, type: z.literal('tool_result'), payload: toolResultPayload }),
  z.object({ ...base, type: z.literal('file_change'), payload: fileChangePayload }),
  z.object({ ...base, type: z.literal('commit'), payload: commitPayload }),
  z.object({ ...base, type: z.literal('status'), payload: statusPayload }),
  z.object({ ...base, type: z.literal('fork_marker'), payload: forkMarkerPayload }),
  z.object({ ...base, type: z.literal('suggestion'), payload: suggestionPayload }),
  z.object({ ...base, type: z.literal('suggestion_decision'), payload: suggestionDecisionPayload }),
  z.object({ ...base, type: z.literal('usage'), payload: usagePayload }),
  z.object({ ...base, type: z.literal('annotation'), payload: annotationPayload }),
])

export type SessionEvent = z.infer<typeof sessionEventSchema>
export type SessionEventType = SessionEvent['type']
export type SessionEventOf<T extends SessionEventType> = Extract<SessionEvent, { type: T }>
export type EventPayloadOf<T extends SessionEventType> = SessionEventOf<T>['payload']

/** Map of type → payload schema, used to validate payloads coming out of the DB. */
export const eventPayloadSchemas = {
  user_message: userMessagePayload,
  assistant_delta: assistantDeltaPayload,
  assistant_message: assistantMessagePayload,
  thinking_delta: thinkingDeltaPayload,
  thought: thoughtPayload,
  check_started: checkStartedPayload,
  check_run: checkRunPayload,
  plan: planPayload,
  steer: steerPayload,
  steer_applied: steerAppliedPayload,
  test_plan: testPlanPayload,
  approval_request: approvalRequestPayload,
  coordination: coordinationPayload,
  approval_decision: approvalDecisionPayload,
  test_verdict: testVerdictPayload,
  tool_call: toolCallPayload,
  tool_result: toolResultPayload,
  file_change: fileChangePayload,
  commit: commitPayload,
  status: statusPayload,
  fork_marker: forkMarkerPayload,
  suggestion: suggestionPayload,
  suggestion_decision: suggestionDecisionPayload,
  usage: usagePayload,
  annotation: annotationPayload,
} as const

/** Event types that are persisted to the DB (everything except the stream deltas). */
export const PERSISTED_EVENT_TYPES: SessionEventType[] = [
  'user_message',
  'assistant_message',
  'thought',
  'check_run',
  'plan',
  'steer',
  'steer_applied',
  'test_plan',
  'test_verdict',
  'approval_request',
  'approval_decision',
  'coordination',
  'tool_call',
  'tool_result',
  'file_change',
  'commit',
  'status',
  'fork_marker',
  'suggestion',
  'suggestion_decision',
  'usage',
  'annotation',
]

/** A short human line describing an event, for dashboard gists and activity feeds. */
export function eventGist(event: SessionEvent): string {
  switch (event.type) {
    case 'user_message':
      return `asked: “${truncate(event.payload.text, 64)}”`
    case 'assistant_delta':
      return 'agent is writing…'
    case 'assistant_message':
      return truncate(event.payload.text.replace(/\s+/g, ' '), 72)
    case 'thinking_delta':
      return 'agent is thinking…'
    case 'thought':
      return `thinking: ${truncate(event.payload.text.replace(/\s+/g, ' '), 64)}`
    case 'check_started':
      return `${event.payload.byName} is running checks…`
    case 'check_run':
      return `checks ${event.payload.status}`
    case 'plan': {
      const doing = event.payload.steps.find((s) => s.status === 'doing') ?? event.payload.steps.find((s) => s.status === 'todo')
      return doing ? `plan: ${truncate(doing.text, 60)}` : 'plan complete'
    }
    case 'steer':
      return `${event.payload.byName} steered: ${truncate(event.payload.text, 60)}`
    case 'steer_applied':
      return 'the agent picked up the steer'
    case 'coordination':
      return event.payload.kind === 'conflict'
        ? `conflict caught with ${event.payload.withName}`
        : event.payload.kind === 'resolved'
          ? `conflict with ${event.payload.withName} resolved`
          : `briefed on ${event.payload.withName}'s work`
    case 'approval_request':
      return `the agent needs approval: ${truncate(event.payload.summary, 60)}`
    case 'approval_decision':
      return event.payload.decision === 'expired' ? 'an approval request lapsed' : `${event.payload.byName} ${event.payload.decision} an agent action`
    case 'test_plan':
      return `${event.payload.cases.length} test case${event.payload.cases.length === 1 ? '' : 's'} to try in the preview`
    case 'test_verdict':
      return `${event.payload.byName} marked a test ${event.payload.verdict === 'pass' ? 'passing' : 'failing'}`
    case 'tool_call': {
      const p = event.payload.input?.['path']
      return typeof p === 'string'
        ? `agent is running ${event.payload.toolName} on ${p}`
        : `agent is running ${event.payload.toolName}`
    }
    case 'tool_result':
      return event.payload.summary
    case 'file_change':
      return `agent is editing ${event.payload.path}`
    case 'commit':
      return `committed: ${truncate(event.payload.plainExplanation, 64)}`
    case 'status':
      return event.payload.status === 'thinking'
        ? 'agent is thinking…'
        : event.payload.status === 'running_tools'
          ? 'agent is working…'
          : event.payload.note ?? event.payload.status
    case 'fork_marker':
      return `${event.payload.byUserName} forked from here`
    case 'suggestion':
      return `${event.payload.suggesterName} suggested: “${truncate(event.payload.text, 56)}”`
    case 'suggestion_decision':
      return `suggestion ${event.payload.decision}`
    case 'usage':
      return `used ${event.payload.inputTokens + event.payload.outputTokens} tokens`
    case 'annotation':
      return event.payload.kind === 'comment'
        ? `${event.payload.authorName} commented`
        : `${event.payload.authorName} reacted`
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
