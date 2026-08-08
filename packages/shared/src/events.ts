import { z } from 'zod'

/**
 * SessionEvent is the atom of the whole system: an append-only, ordered log
 * entry within a session. The event log is the source of truth — the chat UI,
 * the spectator sidebar, and forking are all just views/copies of this log.
 *
 * Persistence rule: every event type is persisted as a row in `session_events`
 * EXCEPT `assistant_delta`, which is broadcast-only (transient). When a
 * streamed message completes, one `assistant_message` is persisted. Transient
 * events carry `seq: null`; persisted events carry a monotonic per-session seq.
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

export const userMessagePayload = z.object({ text: z.string() })
export const assistantDeltaPayload = z.object({ text: z.string() })
export const assistantMessagePayload = z.object({ text: z.string() })
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
})
export const forkMarkerPayload = z.object({
  childSessionId: z.string(),
  byUserName: z.string(),
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
  z.object({ ...base, type: z.literal('tool_call'), payload: toolCallPayload }),
  z.object({ ...base, type: z.literal('tool_result'), payload: toolResultPayload }),
  z.object({ ...base, type: z.literal('file_change'), payload: fileChangePayload }),
  z.object({ ...base, type: z.literal('commit'), payload: commitPayload }),
  z.object({ ...base, type: z.literal('status'), payload: statusPayload }),
  z.object({ ...base, type: z.literal('fork_marker'), payload: forkMarkerPayload }),
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
  tool_call: toolCallPayload,
  tool_result: toolResultPayload,
  file_change: fileChangePayload,
  commit: commitPayload,
  status: statusPayload,
  fork_marker: forkMarkerPayload,
} as const

/** Event types that are persisted to the DB (everything except assistant_delta). */
export const PERSISTED_EVENT_TYPES: SessionEventType[] = [
  'user_message',
  'assistant_message',
  'tool_call',
  'tool_result',
  'file_change',
  'commit',
  'status',
  'fork_marker',
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
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
