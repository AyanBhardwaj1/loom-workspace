import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { clsx } from 'clsx'
import type { BranchInfo, ChangeSummary, MergeResult } from '@loom/shared'
import { DiffStats, UnifiedDiffView } from '../components/EventRow'
import { Avatar, CardSkeleton, EmptyState, SlideOver, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useProject } from './ProjectShell'

type Lens = 'simple' | 'technical'

export function HistoryPage() {
  const { projectId, feed } = useProject()
  const now = useNow(15_000)
  const [lens, setLens] = useState<Lens>('simple')
  const [selected, setSelected] = useState<ChangeSummary | null>(null)

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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-7">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Version history</h1>
            <p className="mt-0.5 text-xs text-ink-400">
              Every change the team's agents made — in plain English, or in git terms. Your call.
            </p>
          </div>
          <div className="ml-auto flex overflow-hidden rounded-xl border border-ink-600">
            {(['simple', 'technical'] as const).map((l) => (
              <button
                key={l}
                onClick={() => setLens(l)}
                className={clsx(
                  'px-3.5 py-1.5 text-xs font-medium capitalize transition-colors',
                  lens === l ? 'bg-accent text-ink-950' : 'bg-ink-850 text-ink-300 hover:text-ink-100',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </header>

        <BranchesStrip projectId={projectId} />

        {changesQuery.isLoading ? (
          <div className="mt-5 space-y-3">
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
            <CardSkeleton lines={2} />
          </div>
        ) : changes.length === 0 ? (
          <div className="mt-5">
            <EmptyState
              emoji="🌱"
              title="No changes yet"
              hint="Start a session in any module and every commit the agent makes will show up here, explained for humans."
            />
          </div>
        ) : (
          <ol className="relative mt-6 space-y-3 border-l border-ink-700 pl-6">
            {changes.map((c) => (
              <li key={c.id} className="relative">
                <span
                  className="absolute -left-[1.72rem] top-4 h-2.5 w-2.5 rounded-full border-2 border-ink-950"
                  style={{ backgroundColor: c.authorAvatarColor }}
                />
                <button
                  onClick={() => setSelected(c)}
                  className={clsx(
                    'card w-full p-4 text-left transition-colors hover:border-accent',
                    feed.freshChangeIds.has(c.id) && 'animate-highlight',
                  )}
                >
                  <div className="text-sm leading-relaxed text-ink-100">
                    {lens === 'simple' ? c.plainExplanation : c.technicalSummary}
                  </div>
                  <div className="mt-1 text-xs text-ink-400">
                    {lens === 'simple' ? c.technicalSummary : c.plainExplanation}
                  </div>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Avatar name={c.authorName} color={c.authorAvatarColor} size="xs" />
                    <span className="text-[11px] text-ink-300">{c.authorName}</span>
                    {c.moduleName && (
                      <span className="chip text-[10px]">
                        {c.moduleEmoji} {c.moduleName}
                      </span>
                    )}
                    <span className="mono-chip">{c.branchName === 'main' ? 'main' : c.branchName.replace(/^session\//, '')}</span>
                    <span className="text-[11px] text-ink-400">
                      {c.filesChanged.length} file{c.filesChanged.length === 1 ? '' : 's'}
                    </span>
                    <span className="ml-auto text-[11px] text-ink-400">{timeAgo(c.createdAt, now)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <ChangeSlideOver projectId={projectId} change={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Branches strip + merge
// ---------------------------------------------------------------------------

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
      const res = await api.post<MergeResult>(`/api/projects/${projectId}/merge`, { branchName })
      setNote({ text: res.message, ok: res.ok })
      void branchesQuery.refetch()
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Merge failed', ok: false })
    } finally {
      setMerging(null)
    }
  }

  const branches = (branchesQuery.data?.branches ?? []).filter((b) => b.aheadOfMain > 0 || b.behindMain > 0)

  if (branchesQuery.isLoading || branches.length === 0) {
    return note ? <MergeNote note={note} /> : null
  }

  return (
    <section className="card p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-300">Session branches</h2>
        <span className="text-[10px] text-ink-400">work that hasn't been folded into the main version yet</span>
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-1">
        {branches.map((b) => (
          <div key={b.branchName} className="min-w-[15rem] shrink-0 rounded-xl border border-ink-700 bg-ink-850 p-3">
            <div className="flex items-center gap-2">
              {b.driverName && <Avatar name={b.driverName} color={b.driverAvatarColor ?? '#8b7cf6'} size="xs" />}
              <span className="truncate font-mono text-[11px] text-ink-200">{b.branchName.replace(/^session\//, '')}</span>
            </div>
            <div className="mt-1.5 text-[11px] text-ink-300">
              {b.moduleEmoji} {b.moduleName ?? 'unknown module'}
            </div>
            <div className="mt-1 text-[11px] text-ink-400">
              {b.aheadOfMain > 0 ? (
                <>
                  <span className="text-accent-soft">{b.aheadOfMain}</span> change{b.aheadOfMain === 1 ? '' : 's'} ahead of main
                </>
              ) : (
                'nothing new'
              )}
              {b.behindMain > 0 && <span> · {b.behindMain} behind</span>}
            </div>
            {b.aheadOfMain > 0 && (
              <button
                onClick={() => void merge(b.branchName)}
                disabled={merging !== null}
                className="btn-secondary mt-2.5 w-full text-xs"
              >
                {merging === b.branchName ? 'Merging…' : '⇥ Merge into main'}
              </button>
            )}
          </div>
        ))}
      </div>
      {note && <MergeNote note={note} />}
    </section>
  )
}

function MergeNote({ note }: { note: { text: string; ok: boolean } }) {
  return (
    <div
      className={clsx(
        'mt-3 rounded-xl border px-3.5 py-2.5 text-xs',
        note.ok ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-red-900 bg-red-950/30 text-red-200',
      )}
    >
      {note.text}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Diff slide-over + file browser
// ---------------------------------------------------------------------------

interface ParsedFileDiff {
  path: string
  changeKind: 'create' | 'edit' | 'delete'
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
    const changeKind = /^new file mode/m.test(chunk) ? 'create' : /^deleted file mode/m.test(chunk) ? 'delete' : 'edit'
    files.push({ path, changeKind, additions, deletions, diff: chunk })
  }
  return files
}

function ChangeSlideOver({
  projectId,
  change,
  onClose,
}: {
  projectId: string
  change: ChangeSummary | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<'diff' | 'files'>('diff')

  const diffQuery = useQuery({
    queryKey: ['change-diff', change?.id],
    queryFn: () => api.get<{ diff: string }>(`/api/changes/${change!.id}/diff`),
    enabled: Boolean(change),
  })

  const parsed = useMemo(() => (diffQuery.data ? parseFullDiff(diffQuery.data.diff) : []), [diffQuery.data])

  return (
    <SlideOver
      open={Boolean(change)}
      onClose={() => {
        setTab('diff')
        onClose()
      }}
      wide
      title={
        change && (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{change.plainExplanation}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-ink-400">
              <span className="font-mono">{change.commitSha.slice(0, 7)}</span>
              <span>·</span>
              <span className="truncate font-mono">{change.branchName}</span>
            </div>
          </div>
        )
      }
    >
      {change && (
        <>
          <div className="mb-4 flex gap-2">
            <button
              onClick={() => setTab('diff')}
              className={clsx('btn text-xs px-3 py-1.5', tab === 'diff' ? 'bg-accent text-ink-950' : 'btn-secondary')}
            >
              What changed
            </button>
            <button
              onClick={() => setTab('files')}
              className={clsx('btn text-xs px-3 py-1.5', tab === 'files' ? 'bg-accent text-ink-950' : 'btn-secondary')}
            >
              View files at this point
            </button>
          </div>

          {tab === 'diff' ? (
            diffQuery.isLoading ? (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            ) : parsed.length === 0 ? (
              <div className="py-6 text-center text-xs text-ink-400">No diff available for this change.</div>
            ) : (
              <div className="space-y-3">
                <div className="font-mono text-xs text-ink-300">{change.technicalSummary}</div>
                {parsed.map((f) => (
                  <UnifiedDiffView
                    key={f.path}
                    path={f.path}
                    changeKind={f.changeKind}
                    additions={f.additions}
                    deletions={f.deletions}
                    diff={f.diff}
                  />
                ))}
              </div>
            )
          ) : (
            <FileBrowser projectId={projectId} refSha={change.commitSha} />
          )}
        </>
      )}
    </SlideOver>
  )
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
      api.get<{ content: string }>(
        `/api/projects/${projectId}/file?ref=${refSha}&path=${encodeURIComponent(selectedPath!)}`,
      ),
    enabled: Boolean(selectedPath),
  })

  if (filesQuery.isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )
  }

  const files = filesQuery.data?.files ?? []

  return (
    <div className="flex gap-4">
      <div className="w-56 shrink-0 space-y-0.5">
        <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-400">
          the whole project as of this change
        </div>
        {files.map((f) => (
          <button
            key={f}
            onClick={() => setSelectedPath(f)}
            className={clsx(
              'block w-full truncate rounded-lg px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors',
              selectedPath === f ? 'bg-accent-faint text-accent' : 'text-ink-300 hover:bg-ink-800',
            )}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {!selectedPath ? (
          <div className="py-10 text-center text-xs text-ink-400">Pick a file to read it (read-only).</div>
        ) : fileQuery.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="border-b border-ink-700 bg-ink-850 px-3 py-1.5 font-mono text-[11px] text-ink-200">
              {selectedPath}
            </div>
            <pre className="max-h-[60vh] overflow-auto p-3 font-mono text-[11px] leading-5 text-ink-200">
              {fileQuery.data?.content ?? ''}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
