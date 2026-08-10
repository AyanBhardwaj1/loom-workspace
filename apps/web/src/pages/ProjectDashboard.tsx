import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Plus } from 'lucide-react'
import type { ChangeSummary, ModuleDto, SessionSummary } from '@loom/shared'
import { Modal } from '../components/overlay'
import { Avatar, Button, LivePill, Pill, cn } from '../components/primitives'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useAuth } from '../state/auth'
import { useProject } from './ProjectShell'

const EMOJI_CHOICES = ['📦', '🏠', '🔐', '📝', '🔔', '💳', '🔍', '📊', '⚡', '🎨', '🧪', '🚀']

export function ProjectDashboard() {
  const { projectId, detailQuery, feed } = useProject()
  const { devMode } = useAuth()
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
            <div>
              <h1 className="text-h2 text-primary">{detail.name}</h1>
              <p className="mt-0.5 text-ui text-secondary">{detail.description}</p>
            </div>
            {devMode && (
              <button
                onClick={() => void simulateTeammate()}
                disabled={ghostBusy}
                className="ml-auto inline-flex h-8 items-center gap-1.5 rounded border border-dashed border-hairline px-3 text-small text-tertiary transition-colors duration-micro hover:border-hairline-hover hover:text-secondary disabled:opacity-50"
                title="Dev tool — a simulated teammate starts a live session"
              >
                <FlaskConical size={14} strokeWidth={1.5} />
                {ghostBusy ? 'Starting…' : 'Simulate teammate'}
              </button>
            )}
          </div>
          {ghostNote && <div className="mt-2 text-small text-lav-300">{ghostNote}</div>}
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
            className="flex min-h-[8.5rem] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-hairline text-tertiary transition-colors duration-fast hover:border-hairline-hover hover:text-secondary"
          >
            <Plus size={18} strokeWidth={1.5} />
            <span className="text-ui">New module</span>
          </button>
        </div>
      </div>

      {/* recent changes — a quiet ledger, not a ticker */}
      <aside className="hidden w-80 shrink-0 flex-col border-l border-hairline lg:flex">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-4">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />
          <span className="text-micro uppercase tracking-[0.08em] text-tertiary">Recent changes</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {recentChanges.length === 0 ? (
            <div className="px-4 py-10 text-center text-small text-tertiary">
              Commits will appear here as the agents work.
              <div className="mt-2">
                <Link to={`/p/${projectId}/history`} className="text-lav-300 hover:text-lav-400">
                  Open version history →
                </Link>
              </div>
            </div>
          ) : (
            recentChanges.map((c, i) => (
              <Link
                key={c.id}
                to={`/p/${projectId}/history`}
                className={cn(
                  'block px-4 py-3 transition-colors duration-micro hover:bg-raised',
                  i > 0 && 'border-t border-hairline',
                  feed.freshChangeIds.has(c.id) && 'animate-highlight',
                )}
              >
                <div className="flex items-center gap-2">
                  <Avatar name={c.authorName} color={c.authorAvatarColor} size="xs" />
                  <span className="text-small font-medium text-secondary">{c.authorName}</span>
                  <span className="tnum ml-auto font-mono text-small text-tertiary">{timeAgo(c.createdAt, now)}</span>
                </div>
                <p className="mt-1.5 line-clamp-3 text-small leading-relaxed text-primary">{c.plainExplanation}</p>
              </Link>
            ))
          )}
        </div>
      </aside>

      <Modal open={moduleDialog} onClose={() => setModuleDialog(false)} title="New module">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                onClick={() => setModuleEmoji(e)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded border text-h4 transition-colors duration-micro',
                  moduleEmoji === e ? 'border-lav-border bg-lav-fill' : 'border-hairline hover:border-hairline-hover',
                )}
              >
                {e}
              </button>
            ))}
          </div>
          <input
            className="loom-input"
            placeholder="Module name (e.g. Search, Billing…)"
            value={moduleName}
            onChange={(e) => setModuleName(e.target.value)}
            autoFocus
          />
          <textarea
            className="loom-input resize-none"
            rows={2}
            placeholder="One line on what this part of the product does"
            value={moduleDesc}
            onChange={(e) => setModuleDesc(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setModuleDialog(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void createModule()} disabled={creating || !moduleName.trim()}>
              {creating ? 'Creating…' : 'Create module'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

const STATUS_TONE = { idea: 'neutral', building: 'warn', stable: 'ok' } as const

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
  const lastLine = live ? (gist && gist.at >= (live.lastEventAt ?? '') ? gist.gist : 'in a live session') : null
  return (
    <button
      data-testid={`module-card-${module.name}`}
      onClick={() => navigate(`/p/${projectId}/m/${module.id}`)}
      className={cn(
        'group relative flex min-h-[8.5rem] flex-col overflow-hidden rounded-lg border bg-surface p-5 text-left transition-colors duration-fast ease-standard',
        live ? 'border-lav-border shadow-live' : 'border-hairline hover:border-hairline-hover hover:bg-raised',
      )}
    >
      {/* miniature thread along the inside-left edge — live cards only */}
      {live && (
        <svg aria-hidden className="absolute bottom-3 left-2 top-3 w-[3px]" preserveAspectRatio="none" viewBox="0 0 3 100">
          <line x1="1.5" y1="0" x2="1.5" y2="100" stroke="var(--thread-rest)" strokeWidth="1.5" />
          <line x1="1.5" y1="0" x2="1.5" y2="100" strokeWidth="1.5" className="thread-current" />
        </svg>
      )}
      <div className="flex items-start gap-3 pl-1">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-hairline bg-inset text-ui">
          {module.emoji}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-h4 text-primary">{module.name}</h3>
          <p className="mt-0.5 line-clamp-1 text-small text-tertiary">{module.description}</p>
        </div>
        {live ? <LivePill /> : <Pill tone={STATUS_TONE[module.status]}>{module.status}</Pill>}
      </div>
      <div className="mt-auto pl-1 pt-4">
        {live ? (
          <div className="flex items-center gap-2">
            <Avatar name={live.driverName} color={live.driverAvatarColor} size="sm" />
            <span className="min-w-0 flex-1 truncate font-mono text-small text-secondary">{lastLine}</span>
            <span className="tnum shrink-0 font-mono text-small text-tertiary">{timeAgo(live.lastEventAt, now)}</span>
          </div>
        ) : (
          <div className="text-small text-tertiary">No live session — click to start one</div>
        )}
      </div>
    </button>
  )
}
