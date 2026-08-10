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
  /** Spectator proposes a next step. Any project member except the driver. */
  z.object({ t: z.literal('suggest'), sessionId: z.string(), text: z.string().min(1).max(2000) }),
  /** Driver accepts (→ runs a turn credited to the suggester) or dismisses. */
  z.object({
    t: z.literal('resolve_suggestion'),
    sessionId: z.string(),
    suggestionId: z.string(),
    decision: z.enum(['accepted', 'dismissed']),
  }),
  /** Request all persisted events with seq > afterSeq. */
  z.object({ t: z.literal('catchup'), sessionId: z.string(), afterSeq: z.number().int().min(0) }),
  /** Driver interrupts the in-flight turn. Partial work is still committed. */
  z.object({ t: z.literal('stop'), sessionId: z.string() }),
  /**
   * Presence hint: which session this connection is actually LOOKING at.
   * Kept separate from `sub` — the spectator sidebar subscribes to streams the
   * user is not focused on, and must not corrupt watcher counts.
   */
  z.object({ t: z.literal('viewing'), sessionId: z.string().nullable() }),
  /**
   * F5 — read position: which EVENT the viewer has in sight, throttled ≥1s
   * client-side. Ephemeral (never persisted); null clears it.
   */
  z.object({ t: z.literal('reading'), sessionId: z.string(), eventId: z.string().nullable() }),
  /** F8 — pin a reaction or comment to an earlier event (any project member). */
  z.object({
    t: z.literal('annotate'),
    sessionId: z.string(),
    targetEventId: z.string(),
    kind: z.enum(['reaction', 'comment']),
    body: z.string().min(1).max(1000),
  }),
  /**
   * Reactions (Big-Additive 1.2) — transient, Instagram-Live style. atSeq
   * anchors to an event row; null = the live edge. Never persisted.
   */
  z.object({ t: z.literal('react'), sessionId: z.string(), emoji: z.string().min(1).max(8), atSeq: z.number().int().nullable() }),
  /** F9 — driver offers the wheel to a watching member. */
  z.object({ t: z.literal('handoff_offer'), sessionId: z.string(), toUserId: z.string() }),
  /** F9 — the offered member accepts or declines. */
  z.object({ t: z.literal('handoff_response'), sessionId: z.string(), accept: z.boolean() }),
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
  /** F5: the event this viewer has in sight (ephemeral read position) */
  readingEventId: z.string().nullable().optional(),
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

/** F13 — a per-user notification row. */
export const notificationSchema = z.object({
  id: z.string(),
  kind: z.enum(['fork', 'merge', 'annotation', 'handoff']),
  text: z.string(),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  readAt: z.string().nullable(),
  createdAt: z.string(),
})
export type NotificationDto = z.infer<typeof notificationSchema>

export const serverMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('event'), sessionId: z.string(), event: sessionEventSchema }),
  z.object({ t: z.literal('catchup_batch'), sessionId: z.string(), events: z.array(sessionEventSchema) }),
  z.object({ t: z.literal('presence'), projectId: z.string(), users: z.array(presenceUserSchema) }),
  z.object({ t: z.literal('project_update'), projectId: z.string(), update: projectUpdateSchema }),
  /** F9 — targeted: the driver offered YOU the wheel. */
  z.object({
    t: z.literal('handoff_request'),
    sessionId: z.string(),
    sessionTitle: z.string(),
    fromName: z.string(),
  }),
  /** 1.2 — a reaction raining on a session (broadcast-only, seq-less). */
  z.object({
    t: z.literal('reaction'),
    sessionId: z.string(),
    emoji: z.string(),
    atSeq: z.number().int().nullable(),
    byName: z.string(),
    byColor: z.string(),
  }),
  /** F13 — targeted: a fresh notification for this user. */
  z.object({ t: z.literal('notification'), notification: notificationSchema }),
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
