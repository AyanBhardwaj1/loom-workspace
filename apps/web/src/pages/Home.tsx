import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Settings2 } from 'lucide-react'
import type { ProjectSummary } from '@loom/shared'
import { AgentModeChip, useAiSettings } from '../components/AiSettingsDialog'
import { openSettings } from '../components/CommandPalette'
import { TopBar } from '../components/TopBar'
import { Modal } from '../components/overlay'
import {
  AvatarStack,
  Button,
  CardSkeleton,
  EmptyState,
  ErrorState,
  LivePill,
  PageHeader,
  SectionLabel,
  StatusDot,
  cn,
} from '../components/primitives'
import { api } from '../lib/api'
import { timeAgo, useNow } from '../lib/time'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

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
  const projects = projectsQuery.data?.projects ?? []
  const liveSessions = projects.reduce((n, p) => n + p.activeSessionCount, 0)

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

      <main id="main" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
          <PageHeader
            title="Projects"
            meta={
              projectsQuery.data ? (
                <span className="tnum inline-flex items-center gap-2">
                  {plural(projects.length, 'project')}
                  <span aria-hidden className="text-tertiary">·</span>
                  {liveSessions > 0 ? (
                    <span className="inline-flex items-center gap-1.5 text-lav-300">
                      <StatusDot tone="accent" />
                      {plural(liveSessions, 'live session')} right now
                    </span>
                  ) : (
                    <span className="text-tertiary">nobody is building right now</span>
                  )}
                </span>
              ) : null
            }
            actions={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus size={16} strokeWidth={1.5} aria-hidden />
                New project
              </Button>
            }
          />

          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <section aria-label="Your projects">
              {projectsQuery.isLoading ? (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
              ) : projects.length === 0 ? (
                <EmptyState
                  className="rounded-lg border border-dashed border-hairline"
                  title="No projects yet"
                  hint="Create a project — its git repo and starter modules are set up for you."
                  action={
                    <Button variant="primary" onClick={() => setCreateOpen(true)}>
                      Create a project
                    </Button>
                  }
                />
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {projects.map((p) => (
                    <ProjectCard key={p.id} project={p} now={now} />
                  ))}
                  <button
                    onClick={() => setCreateOpen(true)}
                    className="flex min-h-[10.5rem] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-hairline text-tertiary transition-colors duration-fast hover:border-hairline-hover hover:text-secondary"
                  >
                    <Plus size={18} strokeWidth={1.5} aria-hidden />
                    <span className="text-ui">New project</span>
                    <span className="text-small">Gets its own repo and starter modules</span>
                  </button>
                </div>
              )}
            </section>

            <aside className="space-y-6" aria-label="Workspace">
              <AgentPanel />
              <div>
                <SectionLabel as="h2" className="mb-2">
                  Get around
                </SectionLabel>
                <dl className="space-y-1.5 text-ui">
                  {[
                    [['⌘', 'K'], 'Jump to any project or live session'],
                    [['h'], 'Version history (inside a project)'],
                    [['?'], 'Every shortcut'],
                  ].map(([keys, label]) => (
                    <div key={label as string} className="flex items-center gap-3">
                      <dt className="flex w-14 shrink-0 gap-1">
                        {(keys as string[]).map((k) => (
                          <kbd key={k}>{k}</kbd>
                        ))}
                      </dt>
                      <dd className="text-secondary">{label as string}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </aside>
          </div>
        </div>
      </main>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New project">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <label className="block">
            <span className="mb-1 block text-small font-medium text-secondary">Name</span>
            <input
              className="loom-input"
              name="project-name"
              autoComplete="off"
              placeholder="e.g. Nimbus…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-small font-medium text-secondary">What are you building?</span>
            <textarea
              className="loom-input resize-none"
              name="project-description"
              rows={3}
              placeholder="A sentence is plenty…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {createError && (
            <div role="alert" className="text-small text-danger">
              {createError}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={creating || !name.trim()}>
              {creating ? 'Setting up repo…' : 'Create project'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

function ProjectCard({ project: p, now }: { project: ProjectSummary; now: number }) {
  const live = p.activeSessionCount > 0
  return (
    <Link
      to={`/p/${p.id}`}
      className={cn(
        'group flex min-h-[10.5rem] flex-col rounded-lg border bg-surface p-5 transition-colors duration-fast ease-standard',
        live ? 'border-lav-border shadow-live' : 'border-hairline hover:border-hairline-hover hover:bg-raised',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-h3 text-primary">{p.name}</h2>
        {live && <LivePill />}
      </div>
      <p className="mt-1 line-clamp-2 text-ui text-secondary">{p.description || 'No description yet.'}</p>
      {live && (
        <p className="tnum mt-2 text-small text-lav-300">
          {plural(p.activeSessionCount, 'session')} being built right now
        </p>
      )}
      <div className="mt-auto flex items-center gap-3 border-t border-hairline pt-3">
        <AvatarStack users={p.members} size="sm" />
        <span className="tnum text-small text-tertiary">{plural(p.moduleCount, 'module')}</span>
        <span className="tnum ml-auto font-mono text-small text-tertiary">{timeAgo(p.lastActivityAt, now)}</span>
      </div>
    </Link>
  )
}

/** What's driving every session right now, with the one action that changes it. */
function AgentPanel() {
  const settings = useAiSettings()
  const s = settings.data
  return (
    <div className="rounded-lg border border-hairline bg-surface p-4">
      <SectionLabel as="h2">Agent</SectionLabel>
      {s ? (
        <>
          <p className="mt-2 text-ui text-primary">
            {s.mode === 'mock' ? 'Mock agent' : s.mode === 'anthropic' ? 'Claude' : 'OpenRouter'}
            {s.model && <span className="font-mono text-code text-secondary"> · {s.model}</span>}
          </p>
          <p className="mt-1 text-small text-tertiary">
            {s.mode === 'mock'
              ? 'Scripted and free — every feature works. Add a key to build with a real model.'
              : `Effort: ${s.reasoning ?? 'auto'} · key ${s.maskedKey ?? '—'}`}
          </p>
        </>
      ) : (
        <div className="skeleton mt-2 h-4 w-2/3" aria-hidden />
      )}
      <Button size="sm" className="mt-3 w-full" onClick={openSettings}>
        <Settings2 size={14} strokeWidth={1.5} aria-hidden />
        {s?.mode === 'mock' ? 'Connect a model' : 'Change model or effort'}
      </Button>
    </div>
  )
}
