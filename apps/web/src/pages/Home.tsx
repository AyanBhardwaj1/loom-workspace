import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ProjectSummary } from '@loom/shared'
import { clsx } from 'clsx'
import { BRAND, BRAND_TAGLINE } from '@loom/shared'
import { AgentModeChip, AiSettingsDialog } from '../components/AiSettingsDialog'
import { AvatarStack, Avatar, CardSkeleton, Dialog, EmptyState, ErrorState } from '../components/ui'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'
import { useAuth } from '../state/auth'

export function Home() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const now = useNow()
  const [createOpen, setCreateOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectSummary[] }>('/api/projects'),
    refetchInterval: 15_000,
  })

  const create = async () => {
    if (!name.trim() || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await api.post<{ project: { id: string } }>('/api/projects', {
        name: name.trim(),
        description: description.trim(),
      })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setCreateOpen(false)
      navigate(`/p/${res.project.id}`)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex items-center gap-4">
        <div className="text-2xl">🧵</div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">{BRAND}</h1>
          <p className="text-xs text-ink-400">{BRAND_TAGLINE}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <AgentModeChip onClick={() => setAiOpen(true)} />
          <button onClick={() => setAiOpen(true)} className="btn-ghost px-2 text-base" title="AI provider settings">
            ⚙
          </button>
          {user && <Avatar name={user.name} color={user.avatarColor} />}
          <button onClick={() => void logout()} className="btn-ghost text-xs">
            Sign out
          </button>
        </div>
      </header>
      <AiSettingsDialog open={aiOpen} onClose={() => setAiOpen(false)} />

      <div className="mb-5 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-ink-300">Projects</h2>
        <button className="btn-primary" onClick={() => setCreateOpen(true)}>
          + New project
        </button>
      </div>

      {projectsQuery.isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : projectsQuery.isError ? (
        <ErrorState
          message={projectsQuery.error instanceof Error ? projectsQuery.error.message : 'Failed to load projects'}
          onRetry={() => void projectsQuery.refetch()}
        />
      ) : projectsQuery.data!.projects.length === 0 ? (
        <EmptyState
          emoji="🌱"
          title="No projects yet"
          hint={`Create your first project — ${BRAND} will set up its git repo and starter modules.`}
          action={
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              Create a project
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projectsQuery.data!.projects.map((p) => {
            const live = p.activeSessionCount > 0
            return (
              <Link
                key={p.id}
                to={`/p/${p.id}`}
                className={clsx(
                  'panel panel-hover group relative overflow-hidden p-5 transition-all duration-200 hover:-translate-y-0.5',
                  live && 'border-thread-add/25',
                )}
              >
                {/* live-activity aura */}
                {live && (
                  <div
                    className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-70 blur-2xl"
                    style={{ background: 'radial-gradient(circle, rgba(56,224,165,0.25), transparent 70%)' }}
                  />
                )}
                {live && (
                  <span className="absolute right-4 top-4 inline-flex items-center gap-1.5 text-[11px] text-thread-add">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-thread-add opacity-60" />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-thread-add" />
                    </span>
                    <span className="font-mono tabular-nums">{p.activeSessionCount} live</span>
                  </span>
                )}
                <h3 className="pr-16 text-base font-semibold tracking-tight transition-colors group-hover:text-accent-soft">
                  {p.name}
                </h3>
                <p className="mt-1 line-clamp-2 min-h-[2rem] text-xs leading-relaxed text-ink-300">{p.description || '—'}</p>
                <div className="mt-4 flex items-center gap-3">
                  <AvatarStack users={p.members} />
                  <span className="micro-label">
                    {p.moduleCount} module{p.moduleCount === 1 ? '' : 's'}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-ink-400">{timeAgo(p.lastActivityAt, now)}</span>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="New project">
        <div className="space-y-3">
          <input
            className="input"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <textarea
            className="input resize-none"
            rows={3}
            placeholder="What are you building? (a sentence is plenty)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {createError && <div className="text-xs text-red-400">{createError}</div>}
          <div className="flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={() => void create()} disabled={creating || !name.trim()}>
              {creating ? 'Setting up repo…' : 'Create project'}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
