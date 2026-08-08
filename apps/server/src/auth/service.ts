import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { UserPublic } from '@loom/shared'
import type { DbHandle } from '../db/client'
import { randomToken, sha256 } from './cookies'

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const AVATAR_COLORS = ['#8b7cf6', '#f59e0b', '#10b981', '#ec4899', '#38bdf8', '#f97316', '#a3e635', '#e879f9']

export function pickAvatarColor(seedString: string): string {
  let h = 0
  for (const ch of seedString) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!
}

export function toPublicUser(u: { id: string; name: string; email: string; avatarColor: string }): UserPublic {
  return { id: u.id, name: u.name, email: u.email, avatarColor: u.avatarColor }
}

export class AuthService {
  constructor(private dbh: DbHandle) {}

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10)
  }

  async signup(name: string, email: string, password: string, avatarColor?: string) {
    const { db, t } = this.dbh
    const normalized = email.trim().toLowerCase()
    const existing = await db.select().from(t.users).where(eq(t.users.email, normalized))
    if (existing.length > 0) return { ok: false as const, error: 'An account with that email already exists' }
    const user = {
      id: ulid(),
      name: name.trim(),
      email: normalized,
      passwordHash: await this.hashPassword(password),
      avatarColor: avatarColor ?? pickAvatarColor(normalized),
      createdAt: new Date().toISOString(),
    }
    await db.insert(t.users).values(user)
    return { ok: true as const, user }
  }

  async login(email: string, password: string) {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.users).where(eq(t.users.email, email.trim().toLowerCase()))
    const user = rows[0]
    if (!user) return null
    const valid = await bcrypt.compare(password, user.passwordHash)
    return valid ? user : null
  }

  /** Creates an auth session row and returns the raw bearer token for the cookie. */
  async createAuthSession(userId: string): Promise<string> {
    const { db, t } = this.dbh
    const token = randomToken()
    await db.insert(t.authSessions).values({
      id: ulid(),
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    })
    return token
  }

  async resolveToken(token: string) {
    const { db, t } = this.dbh
    const rows = await db
      .select({ user: t.users, expiresAt: t.authSessions.expiresAt })
      .from(t.authSessions)
      .innerJoin(t.users, eq(t.authSessions.userId, t.users.id))
      .where(eq(t.authSessions.tokenHash, sha256(token)))
    const row = rows[0]
    if (!row) return null
    if (new Date(row.expiresAt).getTime() < Date.now()) return null
    return row.user
  }

  async revokeToken(token: string): Promise<void> {
    const { db, t } = this.dbh
    await db.delete(t.authSessions).where(eq(t.authSessions.tokenHash, sha256(token)))
  }

  async getUserById(id: string) {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.users).where(eq(t.users.id, id))
    return rows[0] ?? null
  }

  async listUsers(limit = 10) {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.users).orderBy(t.users.createdAt).limit(limit)
    return rows
  }
}
