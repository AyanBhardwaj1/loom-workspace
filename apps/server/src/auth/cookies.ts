import crypto from 'node:crypto'

export const SESSION_COOKIE = 'loom_session'

/**
 * Deterministic HMAC cookie signing, shared by the HTTP layer and the WS
 * upgrade handler (which only sees the raw Cookie header).
 */
export function signValue(raw: string, secret: string): string {
  const mac = crypto.createHmac('sha256', secret).update(raw).digest('base64url')
  return `${raw}.${mac}`
}

export function unsignValue(signed: string, secret: string): string | null {
  const idx = signed.lastIndexOf('.')
  if (idx <= 0) return null
  const raw = signed.slice(0, idx)
  const expected = signValue(raw, secret)
  const a = Buffer.from(signed)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  return raw
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** Minimal Cookie header parser for the WS upgrade path. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}
