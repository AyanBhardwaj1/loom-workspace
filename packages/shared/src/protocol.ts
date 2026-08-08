import { z } from 'zod'
import { moduleStatusSchema, sessionEventSchema, sessionRowStatusSchema } from './events'

/**
 * Typed WebSocket protocol. One endpoint (`/ws`), JSON messages, every message
 * validated with these schemas on both ends.
 */

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export const clientMessageSchema = z.discriminatedUnion('t', [
  /** Subscribe to a session's live event stream (own session or spectate). */
  z.object({ t: z.literal('sub'), sessionId: z.string() }),
  z.object({ t: z.literal('unsub'), sessionId: z.string() }),
  /** Project-level feed: presence, session lifecycle, module changes, new commits. */
  z.object({ t: z.literal('sub_project'), projectId: z.string() }),
  z.object({ t: z.literal('unsub_project'), projectId: z.string() }),
  /** Drive your own session. Server rejects if you are not the driver. */
  z.object({ t: z.literal('user_message'), sessionId: z.string(), text: z.string().min(1).max(20000) }),
  /** Request all persisted events with seq > afterSeq. */
  z.object({ t: z.literal('catchup'), sessionId: z.string(), afterSeq: z.number().int().min(0) }),
])

export type ClientMessage = z.infer<typeof clientMessageSchema>

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export const presenceUserSchema = z.object({
  userId: z.string(),
  name: z.string(),
  avatarColor: z.string(),
  /** sessionId the user is currently viewing (driving or spectating), if any */
  viewing: z.string().nullable(),
})
export type PresenceUser = z.infer<typeof presenceUserSchema>

export const userPublicSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  avatarColor: z.string(),
})

export const sessionSummarySchema = z.object({
  id: z.string(),
  moduleId: z.string(),
  projectId: z.string(),
  driverUserId: z.string(),
  driverName: z.string(),
  driverAvatarColor: z.string(),
  title: z.string(),
  status: sessionRowStatusSchema,
  branchName: z.string(),
  parentSessionId: z.string().nullable(),
  forkedAtEventId: z.string().nullable(),
  lastEventAt: z.string().nullable(),
  createdAt: z.string(),
})
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export const changeSummarySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sessionId: z.string(),
  commitSha: z.string(),
  branchName: z.string(),
  technicalSummary: z.string(),
  plainExplanation: z.string(),
  filesChanged: z.array(
    z.object({
      path: z.string(),
      changeKind: z.enum(['create', 'edit', 'delete']),
      additions: z.number(),
      deletions: z.number(),
    }),
  ),
  authorUserId: z.string(),
  authorName: z.string(),
  authorAvatarColor: z.string(),
  moduleName: z.string().nullable(),
  moduleEmoji: z.string().nullable(),
  createdAt: z.string(),
})
export type ChangeSummary = z.infer<typeof changeSummarySchema>

export const projectUpdateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('change'), change: changeSummarySchema }),
  z.object({ kind: z.literal('session_started'), session: sessionSummarySchema }),
  z.object({ kind: z.literal('session_ended'), sessionId: z.string(), moduleId: z.string() }),
  /** One-line live gist of what is happening inside a session (dashboard liveness). */
  z.object({
    kind: z.literal('session_activity'),
    sessionId: z.string(),
    moduleId: z.string(),
    driverUserId: z.string(),
    driverName: z.string(),
    gist: z.string(),
    at: z.string(),
  }),
  z.object({
    kind: z.literal('module_updated'),
    moduleId: z.string(),
    name: z.string(),
    emoji: z.string(),
    status: moduleStatusSchema,
  }),
  z.object({
    kind: z.literal('merge'),
    branchName: z.string(),
    ok: z.boolean(),
    message: z.string(),
  }),
])
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>

export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('event'), sessionId: z.string(), event: sessionEventSchema }),
  z.object({ t: z.literal('catchup_batch'), sessionId: z.string(), events: z.array(sessionEventSchema) }),
  z.object({ t: z.literal('presence'), projectId: z.string(), users: z.array(presenceUserSchema) }),
  z.object({ t: z.literal('project_update'), projectId: z.string(), update: projectUpdateSchema }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string() }),
])

export type ServerMessage = z.infer<typeof serverMessageSchema>

/** Parse an incoming raw WS frame into a validated ClientMessage (or null). */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  try {
    const json = typeof raw === 'string' ? JSON.parse(raw) : raw
    const res = clientMessageSchema.safeParse(json)
    return res.success ? res.data : null
  } catch {
    return null
  }
}

/** Parse an incoming raw WS frame into a validated ServerMessage (or null). */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  try {
    const json = typeof raw === 'string' ? JSON.parse(raw) : raw
    const res = serverMessageSchema.safeParse(json)
    return res.success ? res.data : null
  } catch {
    return null
  }
}
