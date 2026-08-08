import { createContext, useContext } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { clsx } from 'clsx'
import type { ProjectDetail } from '@loom/shared'
import { Avatar, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { useAuth } from '../state/auth'
import { useProjectFeed, type ProjectFeed } from '../state/useProjectFeed'

interface ProjectContextValue {
  projectId: string
  detailQuery: UseQueryResult<ProjectDetail>
  feed: ProjectFeed
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProject outside ProjectShell')
  return ctx
}

/** Global chrome: slim left rail + live project feed shared by all child pages. */
export function ProjectShell() {
  const { projectId } = useParams<{ projectId: string }>()
  const { user, logout } = useAuth()
  const feed = useProjectFeed(projectId ?? null)

  const detailQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  if (!projectId) return null

  return (
    <ProjectContext.Provider value={{ projectId, detailQuery, feed }}>
      <div className="flex h-full">
        {/* left rail */}
        <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-ink-700 bg-ink-900 py-3">
          <Link to="/" title="All projects" className="mb-1 text-xl transition-transform hover:scale-110">
            🧵
          </Link>
          <div className="mb-2 h-px w-8 bg-ink-700" />
          <NavLink
            to={`/p/${projectId}`}
            end
            title="Dashboard"
            className={({ isActive }) =>
              clsx(
                'flex h-10 w-10 items-center justify-center rounded-xl text-lg transition-colors',
                isActive ? 'bg-accent-faint text-accent' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
              )
            }
          >
            ▦
          </NavLink>
          <NavLink
            to={`/p/${projectId}/history`}
            title="Version history"
            className={({ isActive }) =>
              clsx(
                'flex h-10 w-10 items-center justify-center rounded-xl text-lg transition-colors',
                isActive ? 'bg-accent-faint text-accent' : 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
              )
            }
          >
            🕘
          </NavLink>
          <div className="mt-auto flex flex-col items-center gap-2">
            {feed.presence.length > 0 && (
              <div className="flex flex-col items-center gap-1.5" title="Online now">
                {feed.presence.slice(0, 4).map((p) => (
                  <Avatar key={p.userId} name={p.name} color={p.avatarColor} size="sm" title={`${p.name} is online`} />
                ))}
              </div>
            )}
            {user && (
              <button onClick={() => void logout()} title={`${user.name} — sign out`}>
                <Avatar name={user.name} color={user.avatarColor} />
              </button>
            )}
          </div>
        </nav>

        {/* content */}
        <div className="flex min-w-0 flex-1 flex-col">
          {detailQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-7 w-7" />
            </div>
          ) : detailQuery.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-300">
              <div>Couldn't load this project.</div>
              <button className="btn-secondary" onClick={() => void detailQuery.refetch()}>
                Try again
              </button>
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </div>
    </ProjectContext.Provider>
  )
}
