import { createContext, useContext } from 'react'
import { Outlet, useParams } from 'react-router-dom'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { ProjectDetail } from '@loom/shared'
import { TopBar } from '../components/TopBar'
import { Button, Spinner } from '../components/primitives'
import { api } from '../lib/api'
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

/** Global chrome: the 48px top bar + live project feed shared by all child pages. */
export function ProjectShell() {
  const { projectId } = useParams<{ projectId: string }>()
  const feed = useProjectFeed(projectId ?? null)

  const detailQuery = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectDetail>(`/api/projects/${projectId}`),
    enabled: Boolean(projectId),
  })

  if (!projectId) return null

  return (
    <ProjectContext.Provider value={{ projectId, detailQuery, feed }}>
      <div className="flex h-full flex-col">
        <TopBar projectId={projectId} projectName={detailQuery.data?.name ?? '…'} presence={feed.presence} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detailQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="h-6 w-6" />
            </div>
          ) : detailQuery.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-ui text-secondary">
              <div>Couldn't load this project. Check the server, then try again.</div>
              <Button onClick={() => void detailQuery.refetch()}>Try again</Button>
            </div>
          ) : (
            <Outlet />
          )}
        </div>
      </div>
    </ProjectContext.Provider>
  )
}
