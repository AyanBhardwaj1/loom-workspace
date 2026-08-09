import { clsx } from 'clsx'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { SessionEvent, SessionEventOf } from '@loom/shared'

/** helper: a CSS custom property for the semantic edge glow */
const edge = (color: string): CSSProperties => ({ ['--edge' as string]: color })

/**
 * The event log is the source of truth; this module turns it into chat UI.
 * tool_call/tool_result pairs are merged into one chip, noisy status events
 * are dropped, everything else renders as a rich row.
 */

export type DisplayItem =
  | { kind: 'user'; event: SessionEventOf<'user_message'> }
  | { kind: 'assistant'; event: SessionEventOf<'assistant_message'> }
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
      default:
        break
    }
  }
  return items
}

const TOOL_ICONS: Record<string, string> = {
  list_files: '🗂',
  read_file: '📖',
  write_file: '✏️',
  edit_file: '🪄',
  delete_file: '🗑',
  run_command: '▶',
}

export interface RowActions {
  /** current viewer is the session driver (can accept/dismiss suggestions) */
  isDriver?: boolean
  onResolveSuggestion?: (suggestionId: string, decision: 'accepted' | 'dismissed') => void
}

export function EventRow({
  item,
  compact = false,
  driverName,
  driverColor,
  onFork,
  actions,
}: {
  item: DisplayItem
  compact?: boolean
  driverName: string
  driverColor: string
  /** when set, rows expose a "⑂ fork here" hover affordance */
  onFork?: (eventId: string) => void
  actions?: RowActions
}) {
  const forkId =
    item.kind === 'tool' ? item.call.id : item.kind === 'fork' ? item.event.id : item.kind === 'note' ? item.event.id : item.event.id

  return (
    <div className={clsx('group relative', compact ? 'py-0.5' : 'py-1')}>
      {onFork && item.kind !== 'fork' && item.kind !== 'suggestion' && (
        <button
          onClick={() => onFork(forkId)}
          title="Fork the session from this point"
          className="absolute -right-1 top-0 z-10 hidden rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-accent hover:text-accent group-hover:block"
        >
          ⑂ fork here
        </button>
      )}
      <RowBody item={item} compact={compact} driverName={driverName} driverColor={driverColor} actions={actions} />
    </div>
  )
}

function RowBody({
  item,
  compact,
  driverName,
  driverColor,
  actions,
}: {
  item: DisplayItem
  compact: boolean
  driverName: string
  driverColor: string
  actions?: RowActions
}) {
  switch (item.kind) {
    case 'user': {
      const via = item.event.payload.suggestedByName
      return (
        <div className="flex justify-end py-0.5">
          <div
            className={clsx(
              'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-accent/20 bg-accent/[0.1] px-4 py-2.5 text-ink-100 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]',
              compact ? 'text-xs px-3 py-1.5' : 'text-sm',
            )}
          >
            {!compact && (
              <div className="mb-0.5 text-[11px] font-semibold" style={{ color: driverColor }}>
                {driverName}
                {via && <span className="ml-1 font-normal text-ink-400">· 💡 {via} suggested</span>}
              </div>
            )}
            {item.event.payload.text}
          </div>
        </div>
      )
    }
    case 'assistant':
      return (
        <div
          className={clsx(
            'glow-edge whitespace-pre-wrap py-0.5 pl-3.5 leading-relaxed text-ink-100',
            compact ? 'text-xs' : 'text-sm',
          )}
          style={edge('var(--thread-agent)')}
        >
          <InlineText text={item.event.payload.text} />
        </div>
      )
    case 'tool':
      return <ToolChip item={item} compact={compact} />
    case 'file':
      return <DiffCard event={item.event} compact={compact} />
    case 'commit':
      return <CommitRow event={item.event} compact={compact} />
    case 'note': {
      const isError = item.event.payload.status === 'error'
      return (
        <div
          className={clsx(
            'my-1 text-center text-[11px]',
            isError ? 'text-red-400' : 'text-ink-400',
          )}
        >
          {isError && '⚠ '}
          {item.event.payload.note ?? item.event.payload.status}
        </div>
      )
    }
    case 'fork':
      return (
        <div className="my-2 flex items-center gap-3 text-[11px] text-accent-soft">
          <div className="h-px flex-1 bg-gradient-to-r from-transparent via-accent/40 to-accent/40" />
          <span>⑂ {item.event.payload.byUserName} forked from here</span>
          <div className="h-px flex-1 bg-gradient-to-l from-transparent via-accent/40 to-accent/40" />
        </div>
      )
    case 'suggestion':
      return <SuggestionCard item={item} compact={compact} actions={actions} />
  }
}

function SuggestionCard({
  item,
  compact,
  actions,
}: {
  item: Extract<DisplayItem, { kind: 'suggestion' }>
  compact: boolean
  actions?: RowActions
}) {
  const p = item.event.payload
  const canResolve = actions?.isDriver && item.decision === null && actions.onResolveSuggestion
  return (
    <div
      className={clsx(
        'my-1.5 rounded-xl border border-l-2 px-3.5 py-2.5',
        item.decision === 'dismissed'
          ? 'border-ink-700 border-l-ink-500 bg-ink-850/40 opacity-70'
          : 'border-amber-500/30 border-l-amber-400 bg-amber-500/[0.06]',
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-ink-950"
          style={{ backgroundColor: p.suggesterColor }}
        >
          {p.suggesterName.slice(0, 1).toUpperCase()}
        </span>
        <span className="text-[11px] text-ink-300">
          💡 <span className="font-medium text-ink-100">{p.suggesterName}</span> suggests
        </span>
        {item.decision === 'accepted' && <span className="chip text-[10px] text-emerald-300">✓ accepted</span>}
        {item.decision === 'dismissed' && <span className="chip text-[10px] text-ink-400">dismissed</span>}
      </div>
      <div className={clsx('mt-1.5 whitespace-pre-wrap text-ink-100', compact ? 'text-xs' : 'text-sm')}>{p.text}</div>
      {canResolve && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => actions!.onResolveSuggestion!(p.suggestionId, 'accepted')}
            className="btn-primary px-3 py-1 text-xs"
          >
            ✓ Accept &amp; run
          </button>
          <button
            onClick={() => actions!.onResolveSuggestion!(p.suggestionId, 'dismissed')}
            className="btn-secondary px-3 py-1 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

/** minimal inline renderer: `code` spans only, everything else verbatim */
function InlineText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(`[^`\n]+`)/g), [text])
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={i} className="rounded border border-white/10 bg-black/40 px-1 py-0.5 font-mono text-[0.85em] text-thread-tool">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

function ToolChip({ item, compact }: { item: Extract<DisplayItem, { kind: 'tool' }>; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const { call, result } = item
  const icon = TOOL_ICONS[call.payload.toolName] ?? '🔧'
  const pathArg = typeof call.payload.input.path === 'string' ? String(call.payload.input.path) : null
  const cmdArg = typeof call.payload.input.command === 'string' ? String(call.payload.input.command) : null
  const label = pathArg ?? cmdArg

  return (
    <div className="glow-edge my-0.5 pl-3.5" style={edge('var(--thread-tool)')}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'group/tool inline-flex max-w-full items-center gap-2 rounded-lg border border-thread-tool/25 bg-thread-tool/[0.06] px-2.5 py-1 text-left transition-all duration-150 hover:border-thread-tool/50 hover:bg-thread-tool/10',
          compact ? 'text-[10px]' : 'text-xs',
        )}
      >
        <span className="text-[0.9em] opacity-90">{icon}</span>
        <span className="font-mono font-medium tracking-tight text-thread-tool">{call.payload.toolName}</span>
        {label && <span className="truncate font-mono text-ink-400">{label}</span>}
        {result ? (
          <span
            className="relative flex h-1.5 w-1.5"
            title={result.payload.ok ? 'ok' : 'failed'}
          >
            <span
              className="inline-flex h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: result.payload.ok ? '#38e0a5' : '#f26d6d',
                boxShadow: `0 0 6px 0 ${result.payload.ok ? '#38e0a5' : '#f26d6d'}`,
              }}
            />
          </span>
        ) : (
          <span className="thinking-dots pl-0.5">
            <span style={{ width: 3, height: 3 }} />
            <span style={{ width: 3, height: 3 }} />
            <span style={{ width: 3, height: 3 }} />
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 space-y-1 rounded-lg border border-ink-700 bg-ink-900 p-2.5 font-mono text-[11px] text-ink-300">
          <div className="text-ink-400">input</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(call.payload.input, null, 2)}</pre>
          {result && (
            <>
              <div className="pt-1 text-ink-400">result</div>
              <div className={result.payload.ok ? 'text-emerald-300' : 'text-red-300'}>{result.payload.summary}</div>
              {result.payload.detail && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-ink-300">
                  {result.payload.detail}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const DIFF_COLLAPSE_LINES = 12

export function DiffCard({
  event,
  compact,
  defaultOpen = false,
}: {
  event: SessionEventOf<'file_change'>
  compact: boolean
  defaultOpen?: boolean
}) {
  const p = event.payload
  if (compact) {
    return (
      <div className="my-0.5 inline-flex items-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1 text-[10px]">
        <span>{p.changeKind === 'create' ? '🆕' : p.changeKind === 'delete' ? '🗑' : '📝'}</span>
        <span className="truncate font-mono text-ink-200">{p.path}</span>
        <DiffStats additions={p.additions} deletions={p.deletions} />
      </div>
    )
  }
  return (
    <UnifiedDiffView
      path={p.path}
      changeKind={p.changeKind}
      additions={p.additions}
      deletions={p.deletions}
      diff={p.unifiedDiff}
      defaultOpen={defaultOpen}
    />
  )
}

export function DiffStats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="shrink-0 font-mono">
      <span className="text-emerald-400">+{additions}</span> <span className="text-red-400">−{deletions}</span>
    </span>
  )
}

export function UnifiedDiffView({
  path,
  changeKind,
  additions,
  deletions,
  diff,
  defaultOpen = false,
}: {
  path: string
  changeKind: 'create' | 'edit' | 'delete'
  additions: number
  deletions: number
  diff: string
  defaultOpen?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultOpen)
  const lines = useMemo(
    () => diff.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(l)),
    [diff],
  )
  const shown = expanded ? lines : lines.slice(0, DIFF_COLLAPSE_LINES)
  const hidden = lines.length - shown.length

  const edgeColor =
    changeKind === 'delete' ? 'var(--thread-del)' : changeKind === 'create' ? 'var(--thread-add)' : 'var(--thread-tool)'
  return (
    <div className="glow-edge my-1.5 pl-3.5" style={edge(edgeColor)}>
      <div className="overflow-hidden rounded-xl border border-white/[0.08] bg-black/25">
        <div className="flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.025] px-3 py-1.5 text-xs">
          <span className="text-[0.9em]">{changeKind === 'create' ? '🆕' : changeKind === 'delete' ? '🗑' : '📝'}</span>
          <span className="truncate font-mono tracking-tight text-ink-100">{path}</span>
          <span className="ml-auto">
            <DiffStats additions={additions} deletions={deletions} />
          </span>
        </div>
        <pre className="overflow-x-auto p-0 font-mono text-[11px] leading-5">
          {shown.map((line, i) => (
            <div
              key={i}
              className={clsx(
                'whitespace-pre border-l-2 pl-2.5 pr-3',
                line.startsWith('+')
                  ? 'border-thread-add/60 bg-thread-add/[0.08] text-thread-add'
                  : line.startsWith('-')
                    ? 'border-thread-del/60 bg-thread-del/[0.08] text-thread-del'
                    : line.startsWith('@@')
                      ? 'border-transparent bg-white/[0.03] text-accent-soft'
                      : 'border-transparent text-ink-300',
              )}
            >
              {line || ' '}
            </div>
          ))}
        </pre>
        {hidden > 0 && (
          <button
            onClick={() => setExpanded(true)}
            className="w-full border-t border-white/[0.06] bg-white/[0.02] py-1.5 text-[11px] text-ink-300 transition-colors hover:bg-white/[0.05] hover:text-accent"
          >
            Show {hidden} more line{hidden === 1 ? '' : 's'}
          </button>
        )}
        {expanded && lines.length > DIFF_COLLAPSE_LINES && (
          <button
            onClick={() => setExpanded(false)}
            className="w-full border-t border-white/[0.06] bg-white/[0.02] py-1.5 text-[11px] text-ink-300 transition-colors hover:bg-white/[0.05] hover:text-accent"
          >
            Collapse
          </button>
        )}
      </div>
    </div>
  )
}

function CommitRow({ event, compact }: { event: SessionEventOf<'commit'>; compact: boolean }) {
  const [showTechnical, setShowTechnical] = useState(false)
  const p = event.payload
  if (compact) {
    return (
      <div className="glow-edge my-1 pl-3" style={edge('var(--thread-commit)')}>
        <div className="rounded-lg border border-thread-commit/25 bg-thread-commit/[0.07] px-2.5 py-1.5 text-[10px] text-ink-200">
          <span className="mr-1">📦</span>
          {p.plainExplanation}
        </div>
      </div>
    )
  }
  return (
    <div className="glow-edge my-2 pl-3.5" style={edge('var(--thread-commit)')}>
      <div className="animate-gold-pulse rounded-xl border border-thread-commit/30 bg-thread-commit/[0.06] px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-thread-commit/15 text-sm"
            title="committed to the session branch"
          >
            📦
          </span>
          <div className="min-w-0 flex-1">
            <div className="micro-label mb-0.5 !text-thread-commit">committed</div>
            <div className="text-sm leading-relaxed text-ink-100">{p.plainExplanation}</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowTechnical((v) => !v)}
                className="text-[11px] text-ink-400 underline-offset-2 transition-colors hover:text-thread-commit hover:underline"
              >
                {showTechnical ? 'hide technical summary' : 'technical summary'}
              </button>
              <span className="mono-chip !border-thread-commit/25 !text-thread-commit">{p.commitSha.slice(0, 7)}</span>
            </div>
            {showTechnical && (
              <div className="mt-1.5 font-mono text-xs leading-relaxed text-ink-300">{p.technicalSummary}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
