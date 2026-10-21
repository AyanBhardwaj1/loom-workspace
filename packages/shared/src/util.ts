/** Small dependency-free helpers shared by server and web. */

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'module'
  )
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Short random id for branch names — not for DB keys (those use ulid). */
export function shortId(len = 6): string {
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return out
}

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  /** prompt-cache reads — input the provider served at a steep discount */
  cacheReadTokens: number
  costUsd: number
  /** number of turns that reported usage */
  turns: number
}

/** Sum all `usage` events into running totals (works on any event array). */
export function sumUsage(events: Array<{ type: string; payload: unknown }>): UsageTotals {
  const totals: UsageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, turns: 0 }
  for (const e of events) {
    if (e.type !== 'usage') continue
    const p = e.payload as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; costUsd: number }
    totals.inputTokens += p.inputTokens
    totals.outputTokens += p.outputTokens
    totals.cacheReadTokens += p.cacheReadTokens ?? 0
    totals.costUsd += p.costUsd
    totals.turns += 1
  }
  return totals
}

/** Share of all input tokens served from the prompt cache (0–1). */
export function cacheHitRate(totals: UsageTotals): number {
  const total = totals.inputTokens + totals.cacheReadTokens
  return total === 0 ? 0 : totals.cacheReadTokens / total
}

/** Compact token count: 940 → "940", 12_500 → "12.5k", 3_400_000 → "3.4M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** Estimated USD cost, with enough precision to be meaningful at small sizes. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}
