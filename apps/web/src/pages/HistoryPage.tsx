import { ChevronDown, ChevronRight, FileText, GitMerge, MonitorPlay } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import type { BranchInfo, ChangeSummary, MergeResult } from '@loom/shared'
import { UnifiedDiffView } from '../components/EventRow'
import { PaneBoundary } from '../components/PaneBoundary'
import { PreviewPane } from '../components/PreviewPane'
import { Modal } from '../components/overlay'
import { Avatar, Button, CardSkeleton, EmptyState, MonoChip, SegmentedControl, Spinner, cn } from '../components/primitives'
import { api } from '../lib/api'
import { momentMergeJoin } from '../lib/choreography'
import { timeAgo, useNow } from '../lib/time'
import { useProject } from './ProjectShell'

type Lens = 'simple' | 'technical'

const ROW_H = 56
const LANE_X0 = 10
const LANE_DX = 12
const MAX_LANES = 5

export function HistoryPage() {
  const { projectId, feed } = useProject()
  const now = useNow(15_000)
  const [lens, setLens] = useState<Lens>('simple')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mainPreview, setMainPreview] = useState(false)

  const changesQuery = useQuery({
    queryKey: ['changes', projectId],
    queryFn: () => api.get<{ changes: ChangeSummary[] }>(`/api/projects/${projectId}/changes?limit=100`),
  })

  const changes = useMemo(() => {
    const fromQuery = changesQuery.data?.changes ?? []
    const ids = new Set(fromQuery.map((c) => c.id))
    const merged = [...feed.liveChanges.filter((c) => !ids.has(c.id)), ...fromQuery]
    return merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }, [changesQuery.data, feed.liveChanges])

  const selected = changes.find((c) => c.id === selectedId) ?? null

  // lanes: main first, then branches by first (newest) appearance
  const lanes = useMemo(() => {
    const order: string[] = ['main']
    for (const c of changes) {
      if (!order.includes(c.branchName)) order.push(c.branchName)
    }
    return order
  }, [changes])

  const laneOf = (branch: string) => Math.min(lanes.indexOf(branch), MAX_LANES - 1)
  const laneX = (branch: string) => LANE_X0 + laneOf(branch) * LANE_DX
  const gutterW = LANE_X0 + Math.min(lanes.length, MAX_LANES) * LANE_DX + 6

  return (
    <div className="flex min-h-0 flex-1">
      {/* left — the braided timeline */}
      <div className="flex w-[380px] shrink-0 flex-col border-r border-hairline xl:w-[440px]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-4">
          <h1 className="text-h4 text-primary">Version history</h1>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setMainPreview(true)}>
            <MonitorPlay size={14} strokeWidth={1.5} />
            Preview main
          </Button>
        </div>

        <BranchesStrip projectId={projectId} />

        <div className="min-h-0 flex-1 overflow-y-auto">
          {changesQuery.isLoading ? (
            <div className="space-y-3 p-4">
              <CardSkeleton lines={2} />
              <CardSkeleton lines={2} />
            </div>
          ) : changes.length === 0 ? (
            <EmptyState
              title="No changes yet"
              hint="Start a session in any module — every commit the agent makes lands here, explained for humans."
            />
          ) : (
            <BraidList
              changes={changes}
              lanes={lanes}
              laneX={laneX}
              gutterW={gutterW}
              selectedId={selectedId}
              onSelect={setSelectedId}
              freshIds={feed.freshChangeIds}
              now={now}
            />
          )}
        </div>
      </div>

      {/* right — detail */}
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <PaneBoundary label="change detail">
            <ChangeDetail projectId={projectId} change={selected} lens={lens} onLensChange={setLens} />
          </PaneBoundary>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState title="Select a change" hint="Pick any node on the timeline to read it — in plain English or in git terms." />
          </div>
        )}
      </div>

      <Modal open={mainPreview} onClose={() => setMainPreview(false)} title="Merged main — live preview" width={900}>
        <div className="h-[70vh] overflow-hidden rounded-lg border border-hairline">
          <PreviewPane src={`/preview/main/${projectId}/`} reloadKey={changes.length} label="main branch" />
        </div>
      </Modal>
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * The braid — parallel vertical threads; nodes at fixed 56px rows
 * ------------------------------------------------------------------------- */
function BraidList({
  changes,
  lanes,
  laneX,
  gutterW,
  selectedId,
  onSelect,
  freshIds,
  now,
}: {
  changes: ChangeSummary[]
  lanes: string[]
  laneX: (b: string) => number
  gutterW: number
  selectedId: string | null
  onSelect: (id: string) => void
  freshIds: ReadonlySet<string>
  now: number
}) {
  const totalH = changes.length * ROW_H
  // per-lane vertical extent (first to last change on that lane)
  const laneSpans = useMemo(() => {
    const spans = new Map<string, { from: number; to: number }>()
    changes.forEach((c, i) => {
      const y = i * ROW_H + ROW_H / 2
      const s = spans.get(c.branchName)
      if (!s) spans.set(c.branchName, { from: y, to: y })
      else {
        s.from = Math.min(s.from, y)
        s.to = Math.max(s.to, y)
      }
    })
    return spans
  }, [changes])

  return (
    <div className="relative" style={{ height: totalH }}>
      <svg aria-hidden className="pointer-events-none absolute inset-y-0 left-0" width={gutterW} height={totalH}>
        {lanes.map((branch) => {
          const span = laneSpans.get(branch)
          if (!span) return null
          const x = laneX(branch)
          const isMain = branch === 'main'
          return (
            <path
              key={branch}
              data-lane={branch}
              d={`M ${x} ${isMain ? 0 : span.from} L ${x} ${isMain ? totalH : span.to}`}
              stroke={isMain ? 'var(--thread-branch-active)' : 'var(--thread-branch)'}
              strokeWidth="1.5"
              fill="none"
            />
          )
        })}
      </svg>
      {changes.map((c, i) => {
        const isSelected = c.id === selectedId
        const onMain = c.branchName === 'main'
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={clsx(
              'absolute inset-x-0 flex items-center gap-3 pr-4 text-left transition-colors duration-micro',
              isSelected ? 'bg-lav-fill' : 'hover:bg-raised',
              freshIds.has(c.id) && 'animate-highlight',
            )}
            style={{ top: i * ROW_H, height: ROW_H, paddingLeft: gutterW + 6 }}
          >
            <span
              aria-hidden
              className="absolute rounded-full"
              style={{
                left: laneX(c.branchName) - (onMain ? 3.5 : 2.5),
                top: ROW_H / 2 - (onMain ? 3.5 : 2.5),
                width: onMain ? 7 : 5,
                height: onMain ? 7 : 5,
                background: isSelected ? 'var(--lav-300)' : onMain ? 'var(--thread-branch-active)' : 'var(--thread-node)',
              }}
            />
            <Avatar name={c.authorName} color={c.authorAvatarColor} size="xs" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-code-sm text-primary">{c.plainExplanation}</span>
              <span className="mt-0.5 block truncate font-mono text-small text-tertiary">
                {c.branchName === 'main' ? 'main' : c.branchName.replace(/^session\//, '')}
              </span>
            </span>
            <span className="tnum shrink-0 font-mono text-small text-tertiary">{timeAgo(c.createdAt, now)}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Branch heads — driver avatar + merge; M5 plays on merge
 * ------------------------------------------------------------------------- */
function BranchesStrip({ projectId }: { projectId: string }) {
  const [merging, setMerging] = useState<string | null>(null)
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null)

  const branchesQuery = useQuery({
    queryKey: ['branches', projectId],
    queryFn: () => api.get<{ branches: BranchInfo[] }>(`/api/projects/${projectId}/branches`),
    refetchInterval: 20_000,
  })

  const merge = async (branchName: string) => {
    if (merging) return
    setMerging(branchName)
    setNote(null)
    try {
      // M5 — the branch thread curves in and fuses with main
      const branchPath = document.querySelector<SVGPathElement>(`[data-lane="${CSS.escape(branchName)}"]`)
      const mainPath = document.querySelector<SVGPathElement>('[data-lane="main"]')
      const mergePromise = api.post<MergeResult>(`/api/projects/${projectId}/merge`, { branchName })
      if (branchPath && mainPath) {
        const d = branchPath.getAttribute('d') ?? ''
        const m = /M ([\d.]+) ([\d.]+) L [\d.]+ ([\d.]+)/.exec(d)
        const mainX = /M ([\d.]+)/.exec(mainPath.getAttribute('d') ?? '')?.[1]
        if (m && mainX) {
          const [, bx, by, byEnd] = m
          const joined = `M ${mainX} ${Number(by) - 20} Q ${bx} ${by} ${bx} ${(Number(by) + Number(byEnd)) / 2} L ${bx} ${byEnd}`
          await momentMergeJoin(branchPath, joined, { x: Number(mainX), y: Number(by) - 20 })
        }
      }
      const res = await mergePromise
      setNote({ text: res.message, ok: res.ok })
      void branchesQuery.refetch()
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Merge failed', ok: false })
    } finally {
      setMerging(null)
    }
  }

  const branches = (branchesQuery.data?.branches ?? []).filter((b) => b.aheadOfMain > 0)

  if (branches.length === 0 && !note) return null

  return (
    <div className="shrink-0 border-b border-hairline">
      {branches.map((b) => (
        <div key={b.branchName} className="flex h-10 items-center gap-2 border-b border-hairline px-4 last:border-b-0">
          {b.driverName && <Avatar name={b.driverName} color={b.driverAvatarColor ?? 'var(--lav-500)'} size="xs" />}
          <MonoChip className="min-w-0 shrink" title={b.branchName}>
            {b.branchName.replace(/^session\//, '')}
          </MonoChip>
          <span className="tnum shrink-0 text-small text-tertiary">
            {b.aheadOfMain} ahead{b.behindMain > 0 ? ` · ${b.behindMain} behind` : ''}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            onClick={() => void merge(b.branchName)}
            disabled={merging !== null}
          >
            <GitMerge size={13} strokeWidth={1.5} />
            {merging === b.branchName ? 'Merging…' : 'Merge into main'}
          </Button>
        </div>
      ))}
      {note && (
        <div className={clsx('px-4 py-2 text-small', note.ok ? 'text-ok' : 'text-danger')}>{note.text}</div>
      )}
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * Right pane — Simple / Technical detail + file browser at the commit
 * ------------------------------------------------------------------------- */
interface ParsedFileDiff {
  path: string
  additions: number
  deletions: number
  diff: string
}

function parseFullDiff(diff: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = []
  const chunks = diff.split(/^diff --git /m).filter((c) => c.trim())
  for (const chunk of chunks) {
    const header = chunk.split('\n', 1)[0] ?? ''
    const match = /b\/(.+)$/.exec(header.trim())
    const path = match?.[1] ?? header.trim()
    const additions = (chunk.match(/^\+(?!\+\+)/gm) ?? []).length
    const deletions = (chunk.match(/^-(?!--)/gm) ?? []).length
    files.push({ path, additions, deletions, diff: chunk })
  }
  return files
}

function ChangeDetail({
  projectId,
  change,
  lens,
  onLensChange,
}: {
  projectId: string
  change: ChangeSummary
  lens: Lens
  onLensChange: (l: Lens) => void
}) {
  const [tab, setTab] = useState<'change' | 'files'>('change')

  const diffQuery = useQuery({
    queryKey: ['change-diff', change.id],
    queryFn: () => api.get<{ diff: string }>(`/api/changes/${change.id}/diff`),
  })
  const parsed = useMemo(() => (diffQuery.data ? parseFullDiff(diffQuery.data.diff) : []), [diffQuery.data])

  useEffect(() => setTab('change'), [change.id])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-hairline px-4">
        <MonoChip title={change.commitSha}>{change.commitSha.slice(0, 7)}</MonoChip>
        <MonoChip title={change.branchName}>{change.branchName.replace(/^session\//, '')}</MonoChip>
        {change.moduleName && (
          <span className="hidden text-small text-tertiary md:inline">
            {change.moduleEmoji} {change.moduleName}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            size="sm"
            value={tab === 'files' ? 'files' : lens}
            options={[
              { value: 'simple', label: 'Simple' },
              { value: 'technical', label: 'Technical' },
              { value: 'files', label: 'Files' },
            ]}
            onChange={(v) => {
              if (v === 'files') setTab('files')
              else {
                setTab('change')
                onLensChange(v)
              }
            }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {tab === 'files' ? (
          <FileBrowser projectId={projectId} refSha={change.commitSha} />
        ) : lens === 'simple' ? (
          <div className="mx-auto max-w-[70ch] space-y-4">
            <div className="flex items-center gap-2.5">
              <Avatar name={change.authorName} color={change.authorAvatarColor} size="sm" />
              <span className="text-ui font-medium text-primary">{change.authorName}</span>
            </div>
            <p className="text-body leading-relaxed text-primary">{change.plainExplanation}</p>
            <div className="flex flex-wrap gap-1.5">
              {change.filesChanged.map((f) => (
                <MonoChip key={f.path}>
                  {f.path}
                  <span className="tnum ml-1 text-ok">+{f.additions}</span>
                  <span className="tnum text-danger">−{f.deletions}</span>
                </MonoChip>
              ))}
            </div>
          </div>
        ) : diffQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="mx-auto max-w-[80ch] space-y-3">
            <div className="font-mono text-code-sm text-secondary">{change.technicalSummary}</div>
            {parsed.length === 0 ? (
              <div className="py-6 text-center text-small text-tertiary">No diff available for this change.</div>
            ) : (
              parsed.map((f) => (
                <UnifiedDiffView key={f.path} path={f.path} additions={f.additions} deletions={f.deletions} diff={f.diff} />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/* ----------------------------------------------------------------------------
 * File browser — the whole project as of a commit; 28px rows, folder chevrons
 * ------------------------------------------------------------------------- */
interface TreeDir {
  dirs: Map<string, TreeDir>
  files: string[] // full paths
}

function buildTree(paths: string[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i]!
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] })
      node = node.dirs.get(dir)!
    }
    node.files.push(p)
  }
  return root
}

function FileBrowser({ projectId, refSha }: { projectId: string; refSha: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const filesQuery = useQuery({
    queryKey: ['files', projectId, refSha],
    queryFn: () => api.get<{ files: string[] }>(`/api/projects/${projectId}/files?ref=${refSha}`),
  })

  const fileQuery = useQuery({
    queryKey: ['file', projectId, refSha, selectedPath],
    queryFn: () =>
      api.get<{ content: string }>(`/api/projects/${projectId}/file?ref=${refSha}&path=${encodeURIComponent(selectedPath!)}`),
    enabled: Boolean(selectedPath),
  })

  const tree = useMemo(() => buildTree(filesQuery.data?.files ?? []), [filesQuery.data])

  if (filesQuery.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 gap-5">
      <div className="w-60 shrink-0">
        <div className="mb-2 text-micro uppercase tracking-[0.08em] text-tertiary">Files at this commit</div>
        <TreeLevel node={tree} depth={0} selectedPath={selectedPath} onSelect={setSelectedPath} />
      </div>
      <div className="min-w-0 flex-1">
        {!selectedPath ? (
          <div className="py-10 text-center text-small text-tertiary">Pick a file to read it (read-only).</div>
        ) : fileQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-hairline">
            <div className="border-b border-hairline bg-surface px-3 py-1.5 font-mono text-code-sm text-secondary">
              {selectedPath}
            </div>
            <pre className="max-h-[62vh] overflow-auto bg-inset p-3 font-mono text-code leading-5 text-primary">
              {fileQuery.data?.content ?? ''}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function TreeLevel({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeDir
  depth: number
  selectedPath: string | null
  onSelect: (p: string) => void
}) {
  return (
    <div>
      {[...node.dirs.entries()].map(([name, dir]) => (
        <TreeFolder key={name} name={name} dir={dir} depth={depth} selectedPath={selectedPath} onSelect={onSelect} />
      ))}
      {node.files.map((full) => {
        const name = full.split('/').pop()!
        const isSel = selectedPath === full
        return (
          <button
            key={full}
            onClick={() => onSelect(full)}
            className={cn(
              'flex h-7 w-full items-center gap-1.5 rounded pr-2 text-left font-mono text-code transition-colors duration-micro',
              isSel ? 'bg-lav-fill text-lav-300' : 'text-secondary hover:bg-raised hover:text-primary',
            )}
            style={{ paddingLeft: depth * 14 + 22 }}
          >
            <FileText size={13} strokeWidth={1.5} className="shrink-0 opacity-70" />
            <span className="truncate">{name}</span>
          </button>
        )
      })}
    </div>
  )
}

function TreeFolder({
  name,
  dir,
  depth,
  selectedPath,
  onSelect,
}: {
  name: string
  dir: TreeDir
  depth: number
  selectedPath: string | null
  onSelect: (p: string) => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full items-center gap-1 rounded pr-2 text-left font-mono text-code text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
        style={{ paddingLeft: depth * 14 + 4 }}
      >
        <ChevronRight
          size={13}
          strokeWidth={1.5}
          className={cn('shrink-0 transition-transform duration-micro', open && 'rotate-90')}
        />
        <span className="truncate">{name}/</span>
      </button>
      {open && <TreeLevel node={dir} depth={depth + 1} selectedPath={selectedPath} onSelect={onSelect} />}
    </div>
  )
}
