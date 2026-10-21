import type { SessionEvent, SessionEventOf } from '@loom/shared'

/**
 * Pure (non-component) helpers for the event stream. Kept out of EventRow.tsx
 * so that file exports only React components — a requirement for Vite's Fast
 * Refresh to hot-update the stream UI without a full reload.
 *
 * The event log is the source of truth; toDisplayItems turns it into chat UI:
 * tool_call/tool_result pairs merge into one chip, noisy status/usage events
 * are dropped, everything else becomes a rich row.
 */

export type DisplayItem =
  | { kind: 'user'; event: SessionEventOf<'user_message'> }
  | { kind: 'assistant'; event: SessionEventOf<'assistant_message'> }
  | { kind: 'thought'; event: SessionEventOf<'thought'> }
  | { kind: 'tool'; call: SessionEventOf<'tool_call'>; result: SessionEventOf<'tool_result'> | null }
  | { kind: 'file'; event: SessionEventOf<'file_change'> }
  | { kind: 'commit'; event: SessionEventOf<'commit'> }
  | { kind: 'note'; event: SessionEventOf<'status'> }
  | { kind: 'fork'; event: SessionEventOf<'fork_marker'> }
  | {
      kind: 'suggestion'
      event: SessionEventOf<'suggestion'>
      decision: 'accepted' | 'dismissed' | null
    }

export interface RowActions {
  /** current viewer is the session driver (can accept/dismiss suggestions) */
  isDriver?: boolean
  onResolveSuggestion?: (suggestionId: string, decision: 'accepted' | 'dismissed') => void
  /** lets rows link into the project (fork markers → the forked session) */
  projectId?: string
  /** F4: open the evolution player at the log root (survives row recycling) */
  onPlayEvolution?: (path: string, steps: string[]) => void
  /** F8: pin a reaction ('up'|'spark'|'question'|'flag') or comment to an event */
  onAnnotate?: (targetEventId: string, kind: 'reaction' | 'comment', body: string) => void
}

export function toDisplayItems(events: SessionEvent[]): DisplayItem[] {
  const items: DisplayItem[] = []
  const openToolChips: Array<Extract<DisplayItem, { kind: 'tool' }>> = []
  // decisions may arrive after their suggestion; resolve in a first pass
  const decisions = new Map<string, 'accepted' | 'dismissed'>()
  for (const e of events) {
    if (e.type === 'suggestion_decision') decisions.set(e.payload.suggestionId, e.payload.decision)
  }
  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        // message boundary: any tool call still unpaired belongs to a segment
        // that never completed (e.g. a fork cut mid-turn) — never let a later
        // segment's result pair with it
        openToolChips.length = 0
        items.push({ kind: 'user', event: e })
        break
      case 'assistant_message':
        openToolChips.length = 0
        items.push({ kind: 'assistant', event: e })
        break
      case 'thought':
        items.push({ kind: 'thought', event: e })
        break
      case 'tool_call': {
        const chip: Extract<DisplayItem, { kind: 'tool' }> = { kind: 'tool', call: e, result: null }
        items.push(chip)
        openToolChips.push(chip)
        break
      }
      case 'tool_result': {
        const idx = openToolChips.findIndex((c) => c.result === null && c.call.payload.toolName === e.payload.toolName)
        if (idx >= 0) {
          openToolChips[idx]!.result = e
          openToolChips.splice(idx, 1)
        }
        break
      }
      case 'file_change':
        items.push({ kind: 'file', event: e })
        break
      case 'commit':
        items.push({ kind: 'commit', event: e })
        break
      case 'status':
        if (e.payload.status === 'error' || (e.payload.note && e.payload.status !== 'thinking' && e.payload.status !== 'running_tools')) {
          items.push({ kind: 'note', event: e })
        }
        break
      case 'fork_marker':
        items.push({ kind: 'fork', event: e })
        break
      case 'suggestion':
        items.push({ kind: 'suggestion', event: e, decision: decisions.get(e.payload.suggestionId) ?? null })
        break
      case 'suggestion_decision':
        // folded into its suggestion item above
        break
      case 'usage':
        // metadata for the cost chip, not a chat row
        break
      case 'annotation':
        // F8: attaches under its target event (ChatLog groups them)
        break
      default:
        break
    }
  }
  return items
}
