import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import type { ChangeSummary, ModuleDto, SessionSummary } from '@loom/shared'
import { Avatar, Dialog, EmptyState, StatusPill } from '../components/ui'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useAuth } from '../state/auth'
import { useProject } from './ProjectShell'

const EMOJI_CHOICES = ['📦', '🏠', '🔐', '📝', '🔔', '💳', '🔍', '📊', '⚡', '🎨', '🧪', '🚀']

export function ProjectDashboard() {
  const { projectId, detailQuery, feed } = useProject()
  const { devMode } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const now = useNow(10_000)
  const detail = detailQuery.data!
  const [moduleDialog, setModuleDialog] = useState(false)
  const [moduleName, setModuleName] = useState('')
  const [moduleDesc, setModuleDesc] = useState('')
  const [moduleEmoji, setModuleEmoji] = useState('📦')
  const [creating, setCreating] = useState(false)
  const [ghostBusy, setGhostBusy] = useState(false)
  const [ghostNote, setGhostNote] = useState<string | null>(null)

  const activeByModule = new Map<string, SessionSummary>()
  for (const s of detail.activeSessions) {
    const existing = activeByModule.get(s.moduleId)
    if (!existing || (s.lastEventAt ?? '') > (existing.lastEventAt ?? '')) activeByModule.set(s.moduleId, s)
  }

  const createModule = async () => {
    if (!moduleName.trim() || creating) return
    setCreating(true)
    try {
      await api.post(`/api/projects/${projectId}/modules`, {
        name: moduleName.trim(),
        description: moduleDesc.trim(),
        emoji: moduleEmoji,
      })
      await queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      setModuleDialog(false)
      setModuleName('')
      setModuleDesc('')
    } finally {
      setCreating(false)
    }
  }

  const simulateTeammate = async () => {
    setGhostBusy(true)
    setGhostNote(null)
    try {
      await api.post('/api/dev/ghost', { projectId })
      setGhostNote('Prithviraj joined and started building — watch the module cards.')
    } catch (err) {
      setGhostNote(err instanceof Error ? err.message : 'Could not start the simulation')
    } finally {
      setGhostBusy(false)
      setTimeout(() => setGhostNote(null), 6000)
    }
  }

  const changesQuery = useQuery({
    queryKey: ['changes', projectId],
    queryFn: () => api.get<{ changes: ChangeSummary[] }>(`/api/projects/${projectId}/changes?limit=100`),
  })
  const recentChanges = useMemo(() => {
    const fromQuery = changesQuery.data?.changes ?? []
    const ids = new Set(fromQuery.map((c) => c.id))
    return [...feed.liveChanges.filter((c) => !ids.has(c.id)), ...fromQuery]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 20)
  }, [changesQuery.data, feed.liveChanges])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-7">
        <header className="mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{detail.name}</h1>
            <div className="flex -space-x-1.5">
              {detail.members.map((m) => {
                const online = feed.presence.some((p) => p.userId === m.id)
                return (
                  <div key={m.id} className="relative rounded-full ring-2 ring-ink-950">
                    <Avatar name={m.name} color={m.avatarColor} size="sm" />
                    {online && (
                      <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-ink-950" />
                    )}
                  </div>
                )
              })}
            </div>
            {devMode && (
              <button onClick={() => void simulateTeammate()} disabled={ghostBusy} className="btn-secondary ml-auto text-xs">
                {ghostBusy ? 'Summoning…' : '▶ Simulate teammate'}
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-ink-300">{detail.description}</p>
          {ghostNote && <div className="mt-2 text-xs text-accent-soft">{ghostNote}</div>}
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {detail.modules.map((m) => (
            <ModuleCard
              key={m.id}
              module={m}
              projectId={projectId}
              live={activeByModule.get(m.id) ?? null}
              gist={feed.activityByModule.get(m.id) ?? null}
              now={now}
            />
          ))}
          <button
            onClick={() => setModuleDialog(true)}
            className="flex min-h-[9.5rem] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-ink-600 text-ink-400 transition-colors hover:border-accent hover:text-accent"
          >
            <span className="text-2xl">+</span>
            <span className="text-sm">New module</span>
          </button>
        </div>
      </div>

      {/* live activity feed */}
      <aside className="hidden w-80 shrink-0 flex-col border-l border-ink-700 lg:flex">
        <div className="border-b border-ink-700 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-ink-300">
          Recent changes
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto p-3">
          {recentChanges.length === 0 ? (
            <div className="px-2 py-8 text-center text-xs text-ink-400">
              Changes made in any session will appear here live — in plain English.
              <div className="mt-2">
                <Link to={`/p/${projectId}/history`} className="text-accent-soft hover:underline">
                  Open version history →
                </Link>
              </div>
            </div>
          ) : (
            recentChanges.map((c) => (
              <Link
                key={c.id}
                to={`/p/${projectId}/history`}
                className={clsx(
                  'block rounded-xl border border-ink-700 bg-ink-900 p-3 transition-colors hover:border-ink-500',
                  feed.freshChangeIds.has(c.id) && 'animate-highlight',
                )}
              >
                <div className="flex items-center gap-2">
                  <Avatar name={c.authorName} color={c.authorAvatarColor} size="xs" />
                  <span className="text-[11px] text-ink-300">{c.authorName}</span>
                  {c.moduleEmoji && <span className="text-[11px]">{c.moduleEmoji}</span>}
                  <span className="ml-auto text-[10px] text-ink-400">{timeAgo(c.createdAt, now)}</span>
                </div>
                <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-ink-100">{c.plainExplanation}</p>
              </Link>
            ))
          )}
        </div>
      </aside>

      <Dialog open={moduleDialog} onClose={() => setModuleDialog(false)} title="New module">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                onClick={() => setModuleEmoji(e)}
                className={clsx(
                  'flex h-9 w-9 items-center justify-center rounded-lg border text-lg',
                  moduleEmoji === e ? 'border-accent bg-accent-faint' : 'border-ink-600 hover:border-ink-400',
                )}
              >
                {e}
              </button>
            ))}
          </div>
          <input
            className="input"
            placeholder="Module name (e.g. Search, Billing…)"
            value={moduleName}
            onChange={(e) => setModuleName(e.target.value)}
            autoFocus
          />
          <textarea
            className="input resize-none"
            rows={2}
            placeholder="One line on what this part of the product does"
            value={moduleDesc}
            onChange={(e) => setModuleDesc(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setModuleDialog(false)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => void createModule()} disabled={creating || !moduleName.trim()}>
              {creating ? 'Creating…' : 'Create module'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}

function ModuleCard({
  module,
  projectId,
  live,
  gist,
  now,
}: {
  module: ModuleDto
  projectId: string
  live: SessionSummary | null
  gist: { driverName: string; gist: string; at: string } | null
  now: number
}) {
  const navigate = useNavigate()
  return (
    <button
      data-testid={`module-card-${module.name}`}
      onClick={() => navigate(`/p/${projectId}/m/${module.id}`)}
      className={clsx(
        'card group relative flex min-h-[9.5rem] flex-col p-5 text-left transition-colors hover:border-accent',
        live && 'border-accent/40',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl">{module.emoji}</span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold group-hover:text-accent-soft">{module.name}</h3>
          <p className="mt-0.5 line-clamp-1 text-xs text-ink-400">{module.description}</p>
        </div>
        <StatusPill status={module.status} />
      </div>
      <div className="mt-auto pt-4">
        {live ? (
          <div className="flex items-center gap-2.5">
            <Avatar name={live.driverName} color={live.driverAvatarColor} size="sm" pulsing />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs text-ink-100">
                <span className="font-medium" style={{ color: live.driverAvatarColor }}>
                  {live.driverName}
                </span>
                <span className="text-ink-300">
                  {' '}
                  · {gist && gist.at >= (live.lastEventAt ?? '') ? gist.gist : 'is in a live session'}
                </span>
              </div>
              <div className="text-[10px] text-ink-400">{timeAgo(live.lastEventAt, now)}</div>
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-ink-400">No live session — click to start one</div>
        )}
      </div>
    </button>
  )
}
