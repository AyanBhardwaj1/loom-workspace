import { clsx } from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import type { SessionEvent, SessionEventOf } from '@loom/shared'

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

export function toDisplayItems(events: SessionEvent[]): DisplayItem[] {
  const items: DisplayItem[] = []
  const openToolChips: Array<Extract<DisplayItem, { kind: 'tool' }>> = []
  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        items.push({ kind: 'user', event: e })
        break
      case 'assistant_message':
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

export function EventRow({
  item,
  compact = false,
  driverName,
  driverColor,
  onFork,
}: {
  item: DisplayItem
  compact?: boolean
  driverName: string
  driverColor: string
  /** when set, rows expose a "⑂ fork here" hover affordance */
  onFork?: (eventId: string) => void
}) {
  const forkId =
    item.kind === 'tool' ? item.call.id : item.kind === 'fork' ? item.event.id : item.kind === 'note' ? item.event.id : item.event.id

  return (
    <div className={clsx('group relative', compact ? 'py-0.5' : 'py-1')}>
      {onFork && item.kind !== 'fork' && (
        <button
          onClick={() => onFork(forkId)}
          title="Fork the session from this point"
          className="absolute -right-1 top-0 z-10 hidden rounded-md border border-ink-600 bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300 hover:border-accent hover:text-accent group-hover:block"
        >
          ⑂ fork here
        </button>
      )}
      <RowBody item={item} compact={compact} driverName={driverName} driverColor={driverColor} />
    </div>
  )
}

function RowBody({
  item,
  compact,
  driverName,
  driverColor,
}: {
  item: DisplayItem
  compact: boolean
  driverName: string
  driverColor: string
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div
            className={clsx(
              'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-accent-faint px-4 py-2.5 text-ink-100',
              compact ? 'text-xs px-3 py-1.5' : 'text-sm',
            )}
          >
            {!compact && (
              <div className="mb-0.5 text-[11px] font-semibold" style={{ color: driverColor }}>
                {driverName}
              </div>
            )}
            {item.event.payload.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className={clsx('whitespace-pre-wrap leading-relaxed text-ink-100', compact ? 'text-xs' : 'text-sm')}>
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
  }
}

/** minimal inline renderer: `code` spans only, everything else verbatim */
function InlineText({ text }: { text: string }) {
  const parts = useMemo(() => text.split(/(`[^`\n]+`)/g), [text])
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code key={i} className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[0.85em] text-accent-soft">
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
    <div className="my-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'inline-flex max-w-full items-center gap-2 rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-1 text-left transition-colors hover:border-ink-400',
          compact ? 'text-[10px]' : 'text-xs',
        )}
      >
        <span>{icon}</span>
        <span className="font-mono text-ink-200">{call.payload.toolName}</span>
        {label && <span className="truncate font-mono text-ink-400">{label}</span>}
        {result ? (
          <span className={result.payload.ok ? 'text-emerald-400' : 'text-red-400'}>
            {result.payload.ok ? '✓' : '✗'}
          </span>
        ) : (
          <span className="thinking-dots inline-flex gap-0.5 pl-1">
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

  return (
    <div className="card my-1 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-ink-700 bg-ink-850 px-3 py-1.5 text-xs">
        <span>{changeKind === 'create' ? '🆕' : changeKind === 'delete' ? '🗑' : '📝'}</span>
        <span className="truncate font-mono text-ink-100">{path}</span>
        <span className="ml-auto">
          <DiffStats additions={additions} deletions={deletions} />
        </span>
      </div>
      <pre className="overflow-x-auto p-0 font-mono text-[11px] leading-5">
        {shown.map((line, i) => (
          <div
            key={i}
            className={clsx(
              'px-3 whitespace-pre',
              line.startsWith('+')
                ? 'bg-emerald-950/40 text-emerald-300'
                : line.startsWith('-')
                  ? 'bg-red-950/40 text-red-300'
                  : line.startsWith('@@')
                    ? 'bg-ink-850 text-accent-soft'
                    : 'text-ink-300',
            )}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full border-t border-ink-700 bg-ink-850 py-1.5 text-[11px] text-ink-300 hover:text-accent"
        >
          Show {hidden} more line{hidden === 1 ? '' : 's'}
        </button>
      )}
      {expanded && lines.length > DIFF_COLLAPSE_LINES && (
        <button
          onClick={() => setExpanded(false)}
          className="w-full border-t border-ink-700 bg-ink-850 py-1.5 text-[11px] text-ink-300 hover:text-accent"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

function CommitRow({ event, compact }: { event: SessionEventOf<'commit'>; compact: boolean }) {
  const [showTechnical, setShowTechnical] = useState(false)
  const p = event.payload
  if (compact) {
    return (
      <div className="my-1 rounded-lg border-l-2 border-accent bg-ink-850/70 px-2.5 py-1.5 text-[10px] text-ink-200">
        <span className="mr-1">📦</span>
        {p.plainExplanation}
      </div>
    )
  }
  return (
    <div className="my-1.5 rounded-xl border border-ink-700 border-l-2 border-l-accent bg-ink-850/70 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">📦</span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-ink-100">{p.plainExplanation}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowTechnical((v) => !v)}
              className="text-[11px] text-ink-400 underline-offset-2 hover:text-accent hover:underline"
            >
              {showTechnical ? 'hide technical summary' : 'technical summary'}
            </button>
            <span className="mono-chip">{p.commitSha.slice(0, 7)}</span>
          </div>
          {showTechnical && <div className="mt-1.5 font-mono text-xs text-ink-300">{p.technicalSummary}</div>}
        </div>
      </div>
    </div>
  )
}
