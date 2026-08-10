import { and, desc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { NotificationDto, ServerMessage } from '@loom/shared'
import type { DbHandle } from '../db/client'
import { userTopic, type EventBus } from '../realtime/bus'

/**
 * F13 — lightweight per-user notifications: created server-side on fork /
 * merge / annotation / handoff, fetched over HTTP, live-pushed over the bus.
 */
export class NotificationService {
  constructor(
    private dbh: DbHandle,
    private bus: EventBus,
  ) {}

  async create(input: {
    userId: string
    kind: NotificationDto['kind']
    text: string
    projectId?: string | null
    sessionId?: string | null
  }): Promise<NotificationDto> {
    const { db, t } = this.dbh
    const row = {
      id: ulid(),
      userId: input.userId,
      kind: input.kind,
      text: input.text,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      readAt: null,
      createdAt: new Date().toISOString(),
    }
    await db.insert(t.notifications).values(row)
    const dto: NotificationDto = {
      id: row.id,
      kind: input.kind,
      text: row.text,
      projectId: row.projectId,
      sessionId: row.sessionId,
      readAt: null,
      createdAt: row.createdAt,
    }
    const msg: ServerMessage = { t: 'notification', notification: dto }
    this.bus.publish(userTopic(input.userId), msg)
    return dto
  }

  async listFor(userId: string, limit = 30): Promise<NotificationDto[]> {
    const { db, t } = this.dbh
    const rows = await db
      .select()
      .from(t.notifications)
      .where(eq(t.notifications.userId, userId))
      .orderBy(desc(t.notifications.createdAt))
      .limit(limit)
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as NotificationDto['kind'],
      text: r.text,
      projectId: r.projectId,
      sessionId: r.sessionId,
      readAt: r.readAt,
      createdAt: r.createdAt,
    }))
  }

  async markAllRead(userId: string): Promise<void> {
    const { db, t } = this.dbh
    await db
      .update(t.notifications)
      .set({ readAt: new Date().toISOString() })
      .where(and(eq(t.notifications.userId, userId), isNull(t.notifications.readAt)))
  }
}
