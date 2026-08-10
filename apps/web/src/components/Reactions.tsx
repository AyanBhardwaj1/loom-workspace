import { useEffect, useRef, useState } from 'react'
import { wsClient } from '../lib/ws'

export const REACTION_EMOJI = ['🎉', '❤️', '🔥', '😂', '👀'] as const

export interface FloatingReaction {
  id: string
  emoji: string
  atSeq: number | null
  byName: string
  byColor: string
  /** horizontal wander, -1..1 */
  drift: number
}

export interface ReactionState {
  floats: FloatingReaction[]
  /** seq (or -1 for the live edge) → emoji → count. In-memory only — a moment, not a record. */
  counts: Map<number, Map<string, number>>
}

/**
 * 1.2 — transient reactions for one session: subscribe, accumulate page-lifetime
 * counters, and keep a short-lived float list for the rain animation.
 */
export function useReactions(sessionId: string | null): ReactionState {
  const [floats, setFloats] = useState<FloatingReaction[]>([])
  const [counts, setCounts] = useState<ReactionState['counts']>(new Map())
  const reduced = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    setFloats([])
    setCounts(new Map())
    if (!sessionId) return
    return wsClient.onMessage((msg) => {
      if (msg.t !== 'reaction' || msg.sessionId !== sessionId) return
      const key = msg.atSeq ?? -1
      setCounts((prev) => {
        const next = new Map(prev)
        const per = new Map(next.get(key) ?? [])
        per.set(msg.emoji, (per.get(msg.emoji) ?? 0) + 1)
        next.set(key, per)
        return next
      })
      if (reduced.current) return // counter-only under reduced motion
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const float: FloatingReaction = {
        id,
        emoji: msg.emoji,
        atSeq: msg.atSeq,
        byName: msg.byName,
        byColor: msg.byColor,
        drift: Math.random() * 2 - 1,
      }
      setFloats((prev) => [...prev.slice(-11), float])
      setTimeout(() => setFloats((prev) => prev.filter((f) => f.id !== id)), 1700)
    })
  }, [sessionId])

  return { floats, counts }
}

/** The ghosted hover strip on event rows (spectators only). */
export function ReactionStrip({ onReact }: { onReact: (emoji: string) => void }) {
  return (
    <span className="flex items-center gap-0.5 rounded-full border border-hairline bg-overlay px-1 py-0.5 shadow-dropdown">
      {REACTION_EMOJI.map((e) => (
        <button
          key={e}
          onClick={() => onReact(e)}
          title={`React ${e}`}
          className="rounded-full px-1 text-[13px] leading-none opacity-70 transition-all duration-micro hover:scale-125 hover:opacity-100"
        >
          {e}
        </button>
      ))}
    </span>
  )
}

/** Page-lifetime counter chips on a row ("🔥 4"). */
export function ReactionCounts({ counts }: { counts: Map<string, number> | undefined }) {
  if (!counts || counts.size === 0) return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {[...counts.entries()].map(([emoji, n]) => (
        <span
          key={emoji}
          className="tnum inline-flex h-5 items-center gap-1 rounded-full border border-hairline bg-surface px-1.5 font-mono text-small text-secondary"
        >
          {emoji} {n > 1 ? n : null}
        </span>
      ))}
    </span>
  )
}
