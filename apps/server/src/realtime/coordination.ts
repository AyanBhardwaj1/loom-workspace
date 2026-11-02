import { eq, lt } from 'drizzle-orm'
import type { DbHandle } from '../db/client'

/**
 * Cross-request coordination: short-lived keys with an expiry. Turn leases
 * ("one turn per session"), stop requests, wheel offers and critical-section
 * locks live here. In one long-running process memory is enough; on a
 * serverless platform each request may land on a different instance, so the
 * keys live in the database. Every key expires, so a crashed instance can
 * never wedge a session forever.
 */
export interface Coordination {
  /** atomically claim `key` if free (or expired); false if someone holds it */
  acquire(key: string, ttlMs: number, value?: string): Promise<boolean>
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  del(key: string): Promise<void>
}

export class MemoryCoordination implements Coordination {
  private keys = new Map<string, { value: string; expiresAt: number }>()

  private live(key: string): { value: string; expiresAt: number } | null {
    const k = this.keys.get(key)
    if (!k) return null
    if (k.expiresAt <= Date.now()) {
      this.keys.delete(key)
      return null
    }
    return k
  }

  async acquire(key: string, ttlMs: number, value = '1'): Promise<boolean> {
    if (this.live(key)) return false
    this.keys.set(key, { value, expiresAt: Date.now() + ttlMs })
    return true
  }
  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.keys.set(key, { value, expiresAt: Date.now() + ttlMs })
  }
  async del(key: string): Promise<void> {
    this.keys.delete(key)
  }
}

export class DbCoordination implements Coordination {
  constructor(private dbh: DbHandle) {}

  async acquire(key: string, ttlMs: number, value = '1'): Promise<boolean> {
    const { db, t } = this.dbh
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    // clear an expired holder first; the primary key makes the insert the arbiter
    await db.delete(t.rtKv).where(lt(t.rtKv.expiresAt, new Date().toISOString()))
    const inserted = await db.insert(t.rtKv).values({ key, value, expiresAt }).onConflictDoNothing().returning({ key: t.rtKv.key })
    return inserted.length > 0
  }
  async get(key: string): Promise<string | null> {
    const { db, t } = this.dbh
    const [row] = await db.select().from(t.rtKv).where(eq(t.rtKv.key, key))
    if (!row) return null
    if (row.expiresAt <= new Date().toISOString()) return null
    return row.value
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    const { db, t } = this.dbh
    const expiresAt = new Date(Date.now() + ttlMs).toISOString()
    await db.insert(t.rtKv).values({ key, value, expiresAt }).onConflictDoUpdate({ target: t.rtKv.key, set: { value, expiresAt } })
  }
  async del(key: string): Promise<void> {
    const { db, t } = this.dbh
    await db.delete(t.rtKv).where(eq(t.rtKv.key, key))
  }
}

/** run fn while holding `key`; waits (bounded) for a current holder to finish */
export async function withLock<T>(coord: Coordination, key: string, fn: () => Promise<T>, opts: { ttlMs?: number; waitMs?: number } = {}): Promise<T> {
  const ttl = opts.ttlMs ?? 15_000
  const deadline = Date.now() + (opts.waitMs ?? 10_000)
  while (!(await coord.acquire(key, ttl))) {
    if (Date.now() > deadline) throw new Error('busy — try again in a moment')
    await new Promise((r) => setTimeout(r, 40))
  }
  try {
    return await fn()
  } finally {
    await coord.del(key)
  }
}
