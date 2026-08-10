import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import type { ProjectSummary } from '@loom/shared'
import { AgentModeChip } from '../components/AiSettingsDialog'
import { TopBar } from '../components/TopBar'
import { Modal } from '../components/overlay'
import { AvatarStack, Button, CardSkeleton, EmptyState, ErrorState, LivePill, cn } from '../components/primitives'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'

export function Home() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const now = useNow()
  const [createOpen, setCreateOpen] = useState(false)
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
      setCreateError(err instanceof Error ? err.message : 'Could not create the project. Try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <AgentModeChip />
      </TopBar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-8 py-8">
          <div className="mb-6 flex items-center justify-between">
            <h1 className="text-h2 text-primary">Projects</h1>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} strokeWidth={1.5} />
              New project
            </Button>
          </div>

          {projectsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <CardSkeleton />
              <CardSkeleton />
              <CardSkeleton />
            </div>
          ) : projectsQuery.isError ? (
            <ErrorState
              message={
                projectsQuery.error instanceof Error
                  ? projectsQuery.error.message
                  : 'Could not load projects. Check the server, then try again.'
              }
              onRetry={() => void projectsQuery.refetch()}
            />
          ) : projectsQuery.data!.projects.length === 0 ? (
            <EmptyState
              title="No projects yet"
              hint="Create a project — its git repo and starter modules are set up for you."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create a project
                </Button>
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
                    className={cn(
                      'group rounded-lg border bg-surface p-5 transition-colors duration-fast ease-standard',
                      live
                        ? 'border-lav-border shadow-live'
                        : 'border-hairline hover:border-hairline-hover hover:bg-raised',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="min-w-0 truncate text-h4 text-primary">{p.name}</h3>
                      {live && <LivePill />}
                    </div>
                    <p className="mt-1 line-clamp-2 min-h-[2.25rem] text-small leading-relaxed text-secondary">
                      {p.description || '—'}
                    </p>
                    <div className="mt-4 flex items-center gap-3">
                      <AvatarStack users={p.members} size="sm" />
                      <span className="tnum text-small text-tertiary">
                        {p.moduleCount} module{p.moduleCount === 1 ? '' : 's'}
                      </span>
                      <span className="tnum ml-auto font-mono text-small text-tertiary">
                        {timeAgo(p.lastActivityAt, now)}
                      </span>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New project">
        <div className="space-y-3">
          <input
            className="loom-input"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <textarea
            className="loom-input resize-none"
            rows={3}
            placeholder="What are you building? A sentence is plenty."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {createError && <div className="text-small text-danger">{createError}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void create()} disabled={creating || !name.trim()}>
              {creating ? 'Setting up repo…' : 'Create project'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
