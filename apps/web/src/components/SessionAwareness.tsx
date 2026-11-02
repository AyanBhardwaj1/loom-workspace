import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionEvent, SessionEventOf } from '@loom/shared'
import { timeAgo } from '../lib/time'

const seenKey = (sessionId: string) => `loom.seen.${sessionId}`

function readSeen(sessionId: string): { seq: number; at: string } | null {
  try {
    const raw = localStorage.getItem(seenKey(sessionId))
    if (!raw) return null
    const v = JSON.parse(raw) as { seq?: unknown; at?: unknown }
    return typeof v.seq === 'number' && typeof v.at === 'string' ? { seq: v.seq, at: v.at } : null
  } catch {
    return null
  }
}

/**
 * "Since you left" — a deterministic digest of what changed while this viewer
 * was away, built from the event log alone (no model call, nothing invented).
 * Collaborators who rejoin mid-session otherwise scroll the whole log to
 * reconstruct state; a catch-up of the deltas is what they actually need.
 */
export function CatchUpCard({ sessionId, events, selfId }: { sessionId: string; events: SessionEvent[]; selfId?: string }) {
  // frozen on the first loaded render: the card describes the gap, not the live tail
  const since = useRef<{ seq: number; at: string } | null | undefined>(undefined)
  const [dismissed, setDismissed] = useState(false)
  if (since.current === undefined && events.length > 0) since.current = readSeen(sessionId)

  // remember how far this viewer has seen
  useEffect(() => {
    const last = events[events.length - 1]?.seq
    if (!last) return
    try {
      localStorage.setItem(seenKey(sessionId), JSON.stringify({ seq: last, at: new Date().toISOString() }))
    } catch {
      /* storage unavailable */
    }
  }, [sessionId, events])

  const digest = useMemo(() => {
    const from = since.current
    if (!from) return null
    const fresh = events.filter((e) => (e.seq ?? 0) > from.seq)
    if (fresh.length === 0) return null
    const commits = fresh.filter((e): e is SessionEventOf<'commit'> => e.type === 'commit')
    const decided = new Set(events.filter((e) => e.type === 'suggestion_decision').map((e) => (e as SessionEventOf<'suggestion_decision'>).payload.suggestionId))
    const suggestions = fresh.filter((e): e is SessionEventOf<'suggestion'> => e.type === 'suggestion' && e.payload.suggesterUserId !== selfId)
    const openSuggestions = suggestions.filter((s) => !decided.has(s.payload.suggestionId))
    const comments = fresh.filter((e): e is SessionEventOf<'annotation'> => e.type === 'annotation' && e.payload.kind === 'comment' && e.payload.authorUserId !== selfId)
    const checks = [...fresh].reverse().find((e): e is SessionEventOf<'check_run'> => e.type === 'check_run') ?? null
    const handoff = [...fresh].reverse().find((e): e is SessionEventOf<'status'> => e.type === 'status' && Boolean(e.payload.newDriverName)) ?? null
    const forks = fresh.filter((e) => e.type === 'fork_marker').length
    const lines: string[] = []
    if (commits.length > 0) lines.push(`${commits.length} commit${commits.length === 1 ? '' : 's'} — latest: ${commits[commits.length - 1]!.payload.plainExplanation}`)
    if (checks) lines.push(`Checks ${checks.payload.status}${checks.payload.status === 'passed' ? '' : `: ${checks.payload.results.filter((r) => r.status !== 'pass').map((r) => r.label).join(', ')}`}`)
    if (suggestions.length > 0) lines.push(`${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}${openSuggestions.length > 0 ? ` (${openSuggestions.length} still open)` : ''}`)
    if (comments.length > 0) lines.push(`${comments.length} comment${comments.length === 1 ? '' : 's'} from ${[...new Set(comments.map((c) => c.payload.authorName))].join(', ')}`)
    const failed = fresh.filter((e): e is SessionEventOf<'test_verdict'> => e.type === 'test_verdict' && e.payload.verdict === 'fail' && e.payload.byUserId !== selfId)
    if (failed.length > 0) lines.push(`${failed.length} failing test report${failed.length === 1 ? '' : 's'} from ${[...new Set(failed.map((f) => f.payload.byName))].join(', ')}`)
    const steers = fresh.filter((e): e is SessionEventOf<'steer'> => e.type === 'steer' && e.payload.byUserId !== selfId)
    if (steers.length > 0) lines.push(`${steers[0]!.payload.byName} steered the agent mid-run${steers.length > 1 ? ` ${steers.length} times` : ''}`)
    if (handoff) lines.push(`${handoff.payload.newDriverName} took the wheel`)
    if (forks > 0) lines.push(`Forked ${forks} time${forks === 1 ? '' : 's'}`)
    return lines.length > 0 ? { lines, at: from.at } : null
  }, [events, selfId])

  if (!digest || dismissed) return null
  return (
    <aside aria-label="Since you left" className="relative shrink-0 border-b-2 border-hairline-strong bg-raised py-3 pl-5 pr-12">
      <div className="mx-auto max-w-[760px]">
        <div className="telemetry flex items-center gap-2 text-tertiary">
          <span className="bg-primary px-1.5 text-canvas">Since you left</span>
          <span>{timeAgo(digest.at)}</span>
        </div>
        <ul className="mt-1.5 space-y-0.5">
          {digest.lines.map((l) => (
            <li key={l} className="flex gap-2 text-ui text-primary">
              <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 bg-signal-500" />
              <span className="min-w-0">{l}</span>
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => {
          setDismissed(true)
          // the button is about to vanish — hand focus to the log instead of <body>
          requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="main-log"] [data-log-scroller]')?.focus())
        }}
        aria-label="Dismiss the catch-up"
        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center text-secondary hover:bg-inset hover:text-primary"
      >
        <X size={14} strokeWidth={1.75} />
      </button>
    </aside>
  )
}

/**
 * The agent's intent, pinned: which step it is on and how far along it is.
 * Watchers steer from here — a suggestion lands better against a visible plan.
 */
export function PlanStrip({ plan, working }: { plan: SessionEventOf<'plan'>['payload']; working: boolean }) {
  const idx = plan.steps.findIndex((s) => s.status === 'doing')
  const nextTodo = plan.steps.findIndex((s) => s.status === 'todo')
  const current = idx >= 0 ? idx : nextTodo
  const done = plan.steps.filter((s) => s.status === 'done').length
  if (current < 0 && !working) return null
  return (
    <div className="flex h-8 shrink-0 items-center gap-3 border-b border-hairline bg-surface px-5" role="status" aria-label="Agent plan">
      <span className="telemetry shrink-0 text-tertiary">Plan</span>
      <div aria-hidden className="flex shrink-0 gap-0.5">
        {plan.steps.map((s, i) => (
          <span
            key={i}
            className={
              s.status === 'done' ? 'h-2 w-4 bg-primary' : s.status === 'doing' ? 'h-2 w-4 animate-pulse bg-signal-500' : 'h-2 w-4 border border-hairline-strong'
            }
          />
        ))}
      </div>
      <span className="tnum telemetry shrink-0 text-secondary">
        {done}/{plan.steps.length}
      </span>
      <span className="min-w-0 truncate text-small text-primary" title={current >= 0 ? plan.steps[current]!.text : undefined}>
        {current >= 0 ? plan.steps[current]!.text : 'All steps done'}
      </span>
    </div>
  )
}
