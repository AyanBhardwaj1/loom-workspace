import { lt } from 'drizzle-orm'
import type { DbHandle } from '../db/client'
import { keepAlive } from '../platform/keepAlive'
import { InProcessEventBus } from './bus'

const STREAM_TYPES = new Set(['assistant_delta', 'thinking_delta'])
const DELTA_FLUSH_MS = 250
const OUTBOX_TTL_MS = 10 * 60_000

type Msg = { t?: string; sessionId?: string; event?: { type?: string; payload?: { text?: string } } }

/**
 * The event bus for serverless platforms: every message is written to the
 * `rt_outbox` table, where long-polling clients on any instance read it
 * (`/api/rt/poll`). Local subscribers still get it in-process.
 *
 * Token streams would be one row per token, so stream deltas are coalesced
 * per topic into ≤4 rows a second. A non-stream message on the same topic
 * flushes the pending stream first, so order is preserved.
 */
export class DbOutboxBus extends InProcessEventBus {
  private chain: Promise<void> = Promise.resolve()
  private pending = new Map<string, { msg: Msg; text: string; timer: ReturnType<typeof setTimeout> }>()
  private writes = 0

  constructor(private dbh: DbHandle) {
    super()
  }

  override publish(topic: string, message: unknown): void {
    super.publish(topic, message)
    const m = message as Msg
    const streamType = m.t === 'event' ? m.event?.type : undefined
    if (streamType && STREAM_TYPES.has(streamType)) {
      const key = `${topic}\u0000${streamType}`
      const existing = this.pending.get(key)
      if (existing) {
        existing.text += m.event?.payload?.text ?? ''
        return
      }
      const timer = setTimeout(() => this.flushStream(key, topic), DELTA_FLUSH_MS)
      this.pending.set(key, { msg: m, text: m.event?.payload?.text ?? '', timer })
      return
    }
    // keep order: anything buffered for this topic goes out first
    for (const key of [...this.pending.keys()]) if (key.startsWith(`${topic}\u0000`)) this.flushStream(key, topic)
    this.write(topic, message)
  }

  private flushStream(key: string, topic: string): void {
    const p = this.pending.get(key)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(key)
    const merged = { ...p.msg, event: { ...p.msg.event, payload: { ...p.msg.event?.payload, text: p.text } } }
    this.write(topic, merged)
  }

  private write(topic: string, message: unknown): void {
    const { db, t } = this.dbh
    const body = JSON.stringify(message)
    const createdAt = new Date().toISOString()
    const prune = ++this.writes % 200 === 0
    this.chain = this.chain
      .then(async () => {
        await db.insert(t.rtOutbox).values({ topic, body, createdAt })
        if (prune) {
          const cutoff = new Date(Date.now() - OUTBOX_TTL_MS).toISOString()
          await db.delete(t.rtOutbox).where(lt(t.rtOutbox.createdAt, cutoff))
          await db.delete(t.rtClients).where(lt(t.rtClients.lastSeen, new Date(Date.now() - 60 * 60_000).toISOString()))
        }
      })
      .catch((err) => console.error('[bus] outbox write failed:', err))
    // a serverless instance must not freeze with messages unwritten
    keepAlive(this.chain)
  }

  /** wait until everything published so far (including buffered streams) is written */
  async flush(): Promise<void> {
    for (const key of [...this.pending.keys()]) this.flushStream(key, key.split('\u0000')[0]!)
    await this.chain
  }
}
