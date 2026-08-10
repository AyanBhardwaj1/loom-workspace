import NumberFlow from '@number-flow/react'
import { clsx } from 'clsx'
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  FileJson2,
  FilePen,
  FileText,
  FolderTree,
  GitFork,
  Lightbulb,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { SessionEventOf } from '@loom/shared'
import { flipContainer, momentCommitSettle } from '../lib/choreography'
import { groupForDisplay, parseUnifiedDiff, type DiffGroup } from '../lib/diff'
import { TokenLine, useHighlightedLines } from './code'
import { Avatar, Button, Pill, Spinner, cn } from './primitives'
import type { DisplayItem, RowActions } from './eventStream'

const NUMBER_TIMING: EffectTiming = { duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' }

function clock(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Middle-truncate a path, keeping the filename intact. */
function midTruncate(path: string, max = 44): string {
  if (path.length <= max) return path
  const file = path.split('/').pop() ?? path
  const head = path.slice(0, Math.max(0, max - file.length - 2))
  return `${head}…/${file}`
}

/* ----------------------------------------------------------------------------
 * Row shell — the thread dot + hover segment live here so every event sits
 * on the thread identically. Content starts at the 24px gutter.
 * ------------------------------------------------------------------------- */
export const EventRow = memo(function EventRow({
  item,
  compact = false,
  driverName,
  driverColor,
  animate = false,
  onFork,
  actions,
}: {
  item: DisplayItem
  compact?: boolean
  driverName: string
  driverColor: string
  /** true only for rows that arrive live (not the initial load) */
  animate?: boolean
  onFork?: (eventId: string) => void
  actions?: RowActions
}) {
  const forkId = item.kind === 'tool' ? item.call.id : item.event.id
  const isCommit = item.kind === 'commit'

  return (
    <div
      className={clsx('group relative', compact ? 'py-1' : 'py-2', animate && !isCommit && 'animate-rise')}
      data-event-row
    >
      {/* the node on the thread (commit nodes are drawn inside CommitRow for M4) */}
      {!compact && !isCommit && (
        <span
          aria-hidden
          className="absolute left-[5.5px] top-[calc(50%-2.5px)] h-[5px] w-[5px] rounded-full"
          style={{ background: 'var(--thread-node)' }}
        />
      )}
      {/* discovered: hovering lights the adjacent thread segment */}
      {!compact && (
        <span
          aria-hidden
          className="absolute bottom-0 left-[7.5px] top-0 w-px opacity-0 transition-opacity duration-micro group-hover:opacity-100"
          style={{ background: 'var(--thread-hover)' }}
        />
      )}
      {onFork && item.kind !== 'fork' && item.kind !== 'suggestion' && (
        <button
          onClick={() => onFork(forkId)}
          title="Fork from this point"
          className="absolute right-0 top-1.5 z-0 hidden h-6 w-6 items-center justify-center rounded text-tertiary transition-colors duration-micro hover:bg-raised hover:text-lav-300 group-hover:flex"
        >
          <GitFork size={14} strokeWidth={1.5} />
        </button>
      )}
      <div className={compact ? '' : 'pl-6 pr-8'}>
        <RowBody item={item} compact={compact} driverName={driverName} driverColor={driverColor} animate={animate} actions={actions} />
      </div>
    </div>
  )
})

function RowBody({
  item,
  compact,
  driverName,
  driverColor,
  animate,
  actions,
}: {
  item: DisplayItem
  compact: boolean
  driverName: string
  driverColor: string
  animate: boolean
  actions?: RowActions
}) {
  switch (item.kind) {
    case 'user':
      return <UserBubble event={item.event} compact={compact} driverName={driverName} driverColor={driverColor} />
    case 'assistant':
      return (
        <div className={clsx('max-w-[70ch] whitespace-pre-wrap text-primary', compact ? 'text-small' : 'text-body')}>
          <InlineText text={item.event.payload.text} />
        </div>
      )
    case 'tool':
      return <ToolChip item={item} compact={compact} />
    case 'file':
      return <DiffCard event={item.event} compact={compact} />
    case 'commit':
      return <CommitRow event={item.event} compact={compact} animate={animate} />
    case 'note': {
      const isError = item.event.payload.status === 'error'
      return (
        <div className={clsx('py-0.5 text-center font-mono text-code-sm', isError ? 'text-danger' : 'text-tertiary')}>
          {item.event.payload.note ?? item.event.payload.status}
        </div>
      )
    }
    case 'fork': {
      const p = item.event.payload
      const to = actions?.projectId ? `/p/${actions.projectId}/s/${p.childSessionId}` : null
      const body = (
        <span className="inline-flex items-center gap-2">
          <GitFork size={14} strokeWidth={1.5} className="text-lav-300" />
          <span className="text-small text-secondary">
            <span className="font-medium text-primary">{p.byUserName}</span> forked from here
          </span>
        </span>
      )
      return (
        <div className="flex items-center gap-3 py-0.5">
          <span aria-hidden className="h-px flex-1" style={{ background: 'var(--thread-branch)' }} />
          {to ? (
            <Link to={to} className="rounded px-2 py-1 transition-colors duration-micro hover:bg-raised" title="Open the forked session">
              {body}
            </Link>
          ) : (
            body
          )}
          <span aria-hidden className="h-px flex-1" style={{ background: 'var(--thread-branch)' }} />
        </div>
      )
    }
    case 'suggestion':
      return <SuggestionCard item={item} compact={compact} actions={actions} />
  }
}

/* ----------------------------------------------------------------------------
 * User message — the subtle bubble; the speaker cue, alignment stays unified
 * ------------------------------------------------------------------------- */
function UserBubble({
  event,
  compact,
  driverName,
  driverColor,
}: {
  event: SessionEventOf<'user_message'>
  compact: boolean
  driverName: string
  driverColor: string
}) {
  const via = event.payload.suggestedByName
  return (
    <div
      className={clsx(
        'max-w-[85%] rounded-lg border border-hairline bg-raised',
        compact ? 'px-3 py-2' : 'px-3.5 py-2.5',
      )}
    >
      {!compact && (
        <div className="mb-1 flex items-center gap-2">
          <Avatar name={driverName} color={driverColor} size="xs" />
          <span className="text-small font-medium text-secondary">{driverName}</span>
          {via && (
            <span className="inline-flex items-center gap-1 text-small text-tertiary">
              <Lightbulb size={11} strokeWidth={1.5} />
              {via} suggested
            </span>
          )}
          <span className="tnum ml-auto font-mono text-small text-tertiary">{clock(event.createdAt)}</span>
        </div>
      )}
      <div className={clsx('whitespace-pre-wrap text-primary', compact ? 'text-small' : 'text-body')}>
        {event.payload.text}
      </div>
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
          <code key={i} className="prose-inline-code">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

/* ----------------------------------------------------------------------------
 * Tool chips — 28px pills; running / done / error; Flip expand to args
 * ------------------------------------------------------------------------- */
const TOOL_ICONS: Record<string, ReactNode> = {
  list_files: <FolderTree size={14} strokeWidth={1.5} />,
  read_file: <FileText size={14} strokeWidth={1.5} />,
  write_file: <FilePen size={14} strokeWidth={1.5} />,
  edit_file: <FileDiff size={14} strokeWidth={1.5} />,
  delete_file: <Trash2 size={14} strokeWidth={1.5} />,
  run_command: <Terminal size={14} strokeWidth={1.5} />,
}

function ToolChip({ item, compact }: { item: Extract<DisplayItem, { kind: 'tool' }>; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const { call, result } = item
  const icon = TOOL_ICONS[call.payload.toolName] ?? <Terminal size={14} strokeWidth={1.5} />
  const pathArg = typeof call.payload.input.path === 'string' ? String(call.payload.input.path) : null
  const cmdArg = typeof call.payload.input.command === 'string' ? String(call.payload.input.command) : null
  const isCmd = call.payload.toolName === 'run_command'
  const arg = pathArg ?? cmdArg
  const failed = result ? !result.payload.ok : false

  const toggle = () => {
    if (wrapRef.current) flipContainer(wrapRef.current, () => setOpen((v) => !v))
    else setOpen((v) => !v)
  }

  return (
    <div ref={wrapRef}>
      <button
        onClick={toggle}
        className={clsx(
          'inline-flex h-7 max-w-full items-center gap-2 rounded border bg-surface px-2.5 text-left transition-colors duration-micro',
          failed ? 'border-danger-border' : 'border-hairline hover:border-hairline-hover',
        )}
      >
        <span className="shrink-0 text-secondary">{icon}</span>
        <span
          className={clsx(
            'shrink-0 font-mono text-code-sm font-medium text-primary',
            !result && 'animate-soft-pulse',
          )}
        >
          {call.payload.toolName}
        </span>
        {arg && (
          <span className="min-w-0 truncate font-mono text-code-sm text-tertiary">
            {isCmd ? `$ ${arg}` : midTruncate(arg)}
          </span>
        )}
        {result ? (
          result.payload.ok ? (
            <Check size={13} strokeWidth={2} className="shrink-0 text-ok opacity-60" aria-label="ok" />
          ) : (
            <X size={13} strokeWidth={2} className="shrink-0 text-danger" aria-label="failed" />
          )
        ) : (
          <Spinner className="h-3 w-3 shrink-0" />
        )}
      </button>
      {open && (
        <div className="mt-1.5 max-w-[70ch] space-y-1.5 rounded border border-hairline bg-inset p-2.5 font-mono text-code-sm">
          <div className="text-micro uppercase tracking-[0.08em] text-tertiary">input</div>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-secondary">
            {JSON.stringify(call.payload.input, null, 2)}
          </pre>
          {result && (
            <>
              <div className="pt-1 text-micro uppercase tracking-[0.08em] text-tertiary">result</div>
              <div className={result.payload.ok ? 'text-ok' : 'text-danger'}>{result.payload.summary}</div>
              {result.payload.detail && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-secondary">
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

/* ----------------------------------------------------------------------------
 * Diff cards — the flagship. Shiki `loom-charcoal`, line numbers, collapsed
 * context, 480px clamp with fade, Flip expand.
 * ------------------------------------------------------------------------- */
export function DiffStats({ additions, deletions, flow = false }: { additions: number; deletions: number; flow?: boolean }) {
  return (
    <span className="tnum inline-flex shrink-0 items-center gap-1.5 font-mono text-code-sm">
      <span className="text-ok">
        {flow ? <NumberFlow value={additions} prefix="+" transformTiming={NUMBER_TIMING} spinTiming={NUMBER_TIMING} /> : `+${additions}`}
      </span>
      <span className="text-danger">
        {flow ? <NumberFlow value={deletions} prefix="−" transformTiming={NUMBER_TIMING} spinTiming={NUMBER_TIMING} /> : `−${deletions}`}
      </span>
    </span>
  )
}

const FILE_ICONS: Array<[RegExp, ReactNode]> = [
  [/\.json$/i, <FileJson2 key="j" size={14} strokeWidth={1.5} />],
  [/\.(md|txt)$/i, <FileText key="t" size={14} strokeWidth={1.5} />],
]

function fileIcon(path: string): ReactNode {
  for (const [re, icon] of FILE_ICONS) if (re.test(path)) return icon
  return <FileDiff size={14} strokeWidth={1.5} />
}

export function DiffCard({
  event,
  compact,
  defaultOpen,
  onPlayEvolution,
}: {
  event: SessionEventOf<'file_change'>
  compact: boolean
  defaultOpen?: boolean
  onPlayEvolution?: () => void
}) {
  const p = event.payload
  if (compact) {
    // spectate density: header-only, click expands in place
    return <CompactDiff event={event} />
  }
  return (
    <UnifiedDiffView
      path={p.path}
      additions={p.additions}
      deletions={p.deletions}
      diff={p.unifiedDiff}
      defaultOpen={defaultOpen ?? true}
      onPlayEvolution={onPlayEvolution}
    />
  )
}

function CompactDiff({ event }: { event: SessionEventOf<'file_change'> }) {
  const [open, setOpen] = useState(false)
  const p = event.payload
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-2 rounded border border-hairline bg-surface px-2.5 text-left transition-colors duration-micro hover:border-hairline-hover"
      >
        <span className="shrink-0 text-secondary">{fileIcon(p.path)}</span>
        <span className="min-w-0 truncate font-mono text-code-sm text-primary">{midTruncate(p.path, 30)}</span>
        <span className="ml-auto">
          <DiffStats additions={p.additions} deletions={p.deletions} flow />
        </span>
      </button>
      {open && (
        <div className="mt-1.5">
          <UnifiedDiffView path={p.path} additions={p.additions} deletions={p.deletions} diff={p.unifiedDiff} defaultOpen />
        </div>
      )}
    </div>
  )
}

const CLAMP_PX = 480

export function UnifiedDiffView({
  path,
  additions,
  deletions,
  diff,
  defaultOpen = true,
  onPlayEvolution,
}: {
  path: string
  additions: number
  deletions: number
  diff: string
  defaultOpen?: boolean
  onPlayEvolution?: () => void
}) {
  const [bodyOpen, setBodyOpen] = useState(defaultOpen)
  const [unclamped, setUnclamped] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<number>>(new Set())
  const [needsClamp, setNeedsClamp] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff])
  const groups = useMemo(() => groupForDisplay(parsed.lines), [parsed])
  // one shiki pass over the whole visible document
  const fullText = useMemo(() => parsed.lines.map((l) => l.text).join('\n'), [parsed])
  const tokens = useHighlightedLines(fullText, path)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    setNeedsClamp(el.scrollHeight > CLAMP_PX + 40)
  }, [tokens, expandedGroups, bodyOpen])

  // map group lines back to their global index for token lookup
  let globalIndex = 0
  const indexed: Array<{ group: DiffGroup; start: number; key: number }> = groups.map((group, key) => {
    const start = globalIndex
    globalIndex += group.lines.length
    return { group, start, key }
  })

  return (
    <div ref={wrapRef} className="max-w-[70ch] overflow-hidden rounded-lg border border-hairline bg-surface">
      <button
        onClick={() => {
          if (wrapRef.current) flipContainer(wrapRef.current, () => setBodyOpen((v) => !v))
          else setBodyOpen((v) => !v)
        }}
        className="flex h-9 w-full items-center gap-2 px-3 text-left transition-colors duration-micro hover:bg-raised"
      >
        <span className="shrink-0 text-secondary">{fileIcon(path)}</span>
        <span className="min-w-0 truncate font-mono text-code text-primary" title={path}>
          {midTruncate(path)}
        </span>
        {onPlayEvolution && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onPlayEvolution()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onPlayEvolution()
              }
            }}
            className="shrink-0 rounded border border-hairline px-1.5 py-0.5 text-small text-secondary transition-colors duration-micro hover:border-hairline-hover hover:text-primary"
          >
            Play evolution
          </span>
        )}
        <span className="ml-auto">
          <DiffStats additions={additions} deletions={deletions} flow />
        </span>
        {bodyOpen ? (
          <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-tertiary" />
        ) : (
          <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-tertiary" />
        )}
      </button>

      {bodyOpen && (
        <div className="relative border-t border-hairline bg-inset">
          <div
            ref={bodyRef}
            className="overflow-x-auto"
            style={!unclamped && needsClamp ? { maxHeight: CLAMP_PX, overflowY: 'hidden' } : undefined}
          >
            <table className="w-full border-collapse font-mono text-code leading-5">
              <tbody>
                {indexed.map(({ group, start, key }) =>
                  group.kind === 'collapsed' && !expandedGroups.has(key) ? (
                    <tr key={key}>
                      <td colSpan={3} className="p-0">
                        <button
                          onClick={() =>
                            setExpandedGroups((prev) => new Set(prev).add(key))
                          }
                          className="block w-full py-1 text-center text-small text-tertiary transition-colors duration-micro hover:bg-raised hover:text-secondary"
                        >
                          ⋯ {group.lines.length} unchanged line{group.lines.length === 1 ? '' : 's'}
                        </button>
                      </td>
                    </tr>
                  ) : (
                    group.lines.map((line, i) => {
                      const gi = start + i
                      return (
                        <tr
                          key={`${key}-${i}`}
                          className={
                            line.kind === 'add'
                              ? 'bg-ok-fill'
                              : line.kind === 'del'
                                ? 'bg-danger-fill'
                                : undefined
                          }
                        >
                          <td className="tnum w-[44px] select-none pr-2 text-right align-top text-code-sm" style={{ color: 'rgba(255,255,255,0.28)' }}>
                            {line.oldNo ?? ''}
                          </td>
                          <td className="tnum w-[44px] select-none pr-2.5 text-right align-top text-code-sm" style={{ color: 'rgba(255,255,255,0.28)' }}>
                            {line.newNo ?? ''}
                          </td>
                          <td
                            className={clsx(
                              'whitespace-pre pr-3 align-top text-primary',
                              line.kind === 'add' && 'border-l-2 border-ok pl-2',
                              line.kind === 'del' && 'border-l-2 border-danger pl-2',
                              line.kind === 'ctx' && 'border-l-2 border-transparent pl-2',
                            )}
                          >
                            <TokenLine tokens={tokens?.[gi]} fallback={line.text} />
                          </td>
                        </tr>
                      )
                    })
                  ),
                )}
              </tbody>
            </table>
          </div>
          {!unclamped && needsClamp && (
            <div className="absolute inset-x-0 bottom-0">
              <div className="pointer-events-none h-16" style={{ background: 'linear-gradient(transparent, var(--bg-inset))' }} />
              <button
                onClick={() => {
                  if (wrapRef.current) flipContainer(wrapRef.current, () => setUnclamped(true))
                  else setUnclamped(true)
                }}
                className="block w-full border-t border-hairline bg-inset py-1.5 text-center text-small text-secondary transition-colors duration-micro hover:text-primary"
              >
                Expand
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Commit rows — the product's proudest artifact; M4 target
 * ------------------------------------------------------------------------- */
function CommitRow({ event, compact, animate }: { event: SessionEventOf<'commit'>; compact: boolean; animate: boolean }) {
  const p = event.payload
  const [copied, setCopied] = useState(false)
  const nodeRef = useRef<HTMLSpanElement>(null)
  const rippleRef = useRef<HTMLSpanElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const played = useRef(false)

  useEffect(() => {
    if (!animate || played.current || compact) return
    played.current = true
    const rows = contentRef.current ? (Array.from(contentRef.current.children) as HTMLElement[]) : []
    if (nodeRef.current && rippleRef.current) momentCommitSettle(nodeRef.current, rippleRef.current, rows)
  }, [animate, compact])

  const copySha = async () => {
    try {
      await navigator.clipboard.writeText(p.commitSha)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked */
    }
  }

  if (compact) {
    return (
      <div className="rounded border border-hairline bg-surface px-2.5 py-1.5 text-small text-primary">
        {p.plainExplanation}
      </div>
    )
  }

  return (
    <div className="relative">
      {/* the 7px commit node, brighter, on the thread (gutter is -24px left) */}
      <span
        ref={nodeRef}
        aria-hidden
        className="absolute -left-[19.5px] top-[1.35rem] h-[7px] w-[7px] rounded-full bg-lav-300"
      />
      <span
        ref={rippleRef}
        aria-hidden
        className="pointer-events-none absolute -left-[24.5px] top-[1.05rem] h-[17px] w-[17px] rounded-full border border-lav-border opacity-0"
      />
      <div ref={contentRef} className="max-w-[70ch] rounded-lg border border-hairline bg-surface p-4">
        <div className="text-body leading-relaxed text-primary">{p.plainExplanation}</div>
        <div className="mt-1 font-mono text-code-sm text-secondary">{p.technicalSummary}</div>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            onClick={() => void copySha()}
            title="Copy the full commit SHA"
            className="tnum inline-flex items-center gap-1.5 rounded border border-hairline bg-inset px-1.5 py-0.5 font-mono text-code-sm text-secondary transition-colors duration-micro hover:border-hairline-hover hover:text-primary"
          >
            {copied ? <Check size={11} strokeWidth={2} className="text-ok" /> : <Copy size={11} strokeWidth={1.5} />}
            {p.commitSha.slice(0, 7)}
          </button>
          <span className="tnum ml-auto font-mono text-small text-tertiary">{clock(event.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Suggestions — spectator proposals; pending = warn accent, resolved quiet
 * ------------------------------------------------------------------------- */
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
  const dismissed = item.decision === 'dismissed'
  return (
    <div
      className={clsx(
        'max-w-[70ch] rounded-lg border bg-surface p-3',
        dismissed ? 'border-hairline opacity-60' : 'border-warn-border',
      )}
    >
      <div className="flex items-center gap-2">
        <Avatar name={p.suggesterName} color={p.suggesterColor} size="xs" />
        <span className="inline-flex items-center gap-1.5 text-small text-secondary">
          <Lightbulb size={12} strokeWidth={1.5} className={dismissed ? undefined : 'text-warn'} />
          <span className="font-medium text-primary">{p.suggesterName}</span> suggests
        </span>
        {item.decision === 'accepted' && <Pill tone="ok">accepted</Pill>}
        {item.decision === 'dismissed' && <Pill>dismissed</Pill>}
      </div>
      <div className={clsx('mt-1.5 whitespace-pre-wrap text-primary', compact ? 'text-small' : 'text-body')}>{p.text}</div>
      {canResolve && (
        <div className="mt-2.5 flex gap-2">
          <Button variant="primary" size="sm" onClick={() => actions!.onResolveSuggestion!(p.suggestionId, 'accepted')}>
            Accept &amp; run
          </Button>
          <Button variant="ghost" size="sm" onClick={() => actions!.onResolveSuggestion!(p.suggestionId, 'dismissed')}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  )
}
