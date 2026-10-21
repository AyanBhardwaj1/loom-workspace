import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, FlaskConical, Plus } from 'lucide-react'
import type { ChangeSummary, ModuleDto, SessionSummary } from '@loom/shared'
import { Modal } from '../components/overlay'
import { Avatar, Button, LivePill, PageHeader, Pill, cn } from '../components/primitives'
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
  const [moduleError, setModuleError] = useState<string | null>(null)
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
    setModuleError(null)
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
    } catch (err) {
      setModuleError(err instanceof Error ? err.message : 'Could not create the module. Try again.')
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
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-7 sm:px-8">
        <PageHeader
          className="mb-6"
          title={detail.name}
          meta={
            <span className="tnum">
              {detail.description}
              {activeByModule.size > 0 && (
                <span className="ml-2 inline-flex items-center gap-1.5 text-lav-300">
                  <span aria-hidden className="text-tertiary">·</span>
                  {activeByModule.size} module{activeByModule.size === 1 ? '' : 's'} live
                </span>
              )}
            </span>
          }
          actions={
            devMode ? (
              <button
                onClick={() => void simulateTeammate()}
                disabled={ghostBusy}
                className="inline-flex h-8 items-center gap-1.5 rounded border border-dashed border-hairline px-3 text-small text-tertiary transition-colors duration-micro hover:border-hairline-hover hover:text-secondary disabled:opacity-50"
                title="Dev tool — a simulated teammate starts a live session"
              >
                <FlaskConical size={14} strokeWidth={1.5} aria-hidden />
                {ghostBusy ? 'Starting…' : 'Simulate teammate'}
              </button>
            ) : undefined
          }
        />
        {ghostNote && (
          <div role="status" className="-mt-3 mb-5 text-small text-lav-300">
            {ghostNote}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {detail.modules.map((m) => (
            <ModuleCard
              key={m.id}
              module={m}
              projectId={projectId}
              live={activeByModule.get(m.id) ?? null}
              gist={feed.activityByModule.get(m.id) ?? null}
              ticker={activeByModule.get(m.id) ? (feed.tickerBySession.get(activeByModule.get(m.id)!.id) ?? null) : null}
              watcherCount={activeByModule.get(m.id) ? feed.presence.filter((p) => p.viewing === activeByModule.get(m.id)!.id).length : 0}
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
          <span className="text-small font-medium text-tertiary">Recent changes</span>
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
                to={`/p/${projectId}/history?change=${c.id}`}
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
        <form
          className="space-y-3"
          onSubmit={(ev) => {
            ev.preventDefault()
            void createModule()
          }}
        >
          <div role="radiogroup" aria-label="Module icon" className="flex flex-wrap gap-1.5">
            {EMOJI_CHOICES.map((e) => (
              <button
                key={e}
                type="button"
                role="radio"
                aria-checked={moduleEmoji === e}
                aria-label={`Icon ${e}`}
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
          <label className="block">
            <span className="mb-1 block text-small font-medium text-secondary">Name</span>
            <input
              className="loom-input"
              name="module-name"
              autoComplete="off"
              placeholder="e.g. Search, Billing…"
              value={moduleName}
              onChange={(e) => setModuleName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-small font-medium text-secondary">What it does</span>
            <textarea
              className="loom-input resize-none"
              name="module-description"
              rows={2}
              placeholder="One line on this part of the product…"
              value={moduleDesc}
              onChange={(e) => setModuleDesc(e.target.value)}
            />
          </label>
          {moduleError && (
            <div role="alert" className="text-small text-danger">
              {moduleError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setModuleDialog(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={creating || !moduleName.trim()}>
              {creating ? 'Creating…' : 'Create module'}
            </Button>
          </div>
        </form>
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
  ticker,
  watcherCount,
  now,
}: {
  module: ModuleDto
  projectId: string
  live: SessionSummary | null
  gist: { driverName: string; gist: string; at: string } | null
  /** 1.3 — last 3 gists: a window into the session */
  ticker: Array<{ gist: string; at: string }> | null
  watcherCount: number
  now: number
}) {
  const lastLine = live ? (gist && gist.at >= (live.lastEventAt ?? '') ? gist.gist : 'in a live session') : null
  return (
    <Link
      data-testid={`module-card-${module.name}`}
      to={`/p/${projectId}/m/${module.id}`}
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
          <h2 className="truncate text-h4 text-primary">{module.name}</h2>
          <p className="mt-0.5 line-clamp-1 text-small text-tertiary">{module.description}</p>
        </div>
        {live ? <LivePill /> : <Pill tone={STATUS_TONE[module.status]}>{module.status}</Pill>}
      </div>
      <div className="mt-auto pl-1 pt-4">
        {live ? (
          <>
            {/* 1.3 — the ticker: newest at the bottom, older lines fade upward */}
            {ticker && ticker.length > 1 && (
              <div className="ticker-mask mb-1.5 space-y-0.5 overflow-hidden">
                {ticker.slice(0, -1).map((t, i) => (
                  <div key={`${t.at}-${i}`} className="animate-rise truncate font-mono text-small text-tertiary">
                    {t.gist}
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Avatar name={live.driverName} color={live.driverAvatarColor} size="sm" />
              <span className="min-w-0 flex-1 truncate font-mono text-small text-secondary">{lastLine}</span>
              {watcherCount > 0 && (
                <span className="tnum inline-flex shrink-0 items-center gap-1 font-mono text-small text-tertiary" title="Watching now">
                  <Eye size={11} strokeWidth={1.5} />
                  {watcherCount}
                </span>
              )}
              <span className="tnum shrink-0 font-mono text-small text-tertiary">{timeAgo(live.lastEventAt, now)}</span>
            </div>
          </>
        ) : (
          <div className="text-small text-tertiary">No live session — open to start one</div>
        )}
      </div>
    </Link>
  )
}
