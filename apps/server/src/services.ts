import { AgentRuntime } from './agent/runtime'
import { AgentOrchestrator } from './agent/orchestrator'
import { AuthService } from './auth/service'
import { createDb, type DbHandle } from './db/client'
import type { ServerConfig } from './env'
import { GhostCollaborator } from './ghost/ghost'
import { MergeService } from './git/mergeService'
import { ProjectService } from './projects/service'
import { InProcessEventBus, type EventBus } from './realtime/bus'
import { Hub } from './realtime/hub'
import { SessionService } from './sessions/service'

export interface Services {
  config: ServerConfig
  dbh: DbHandle
  bus: EventBus
  auth: AuthService
  projects: ProjectService
  sessions: SessionService
  orchestrator: AgentOrchestrator
  merge: MergeService
  ghost: GhostCollaborator
  hub: Hub
  runtime: AgentRuntime
  close(): Promise<void>
}

export async function createServices(
  config: ServerConfig,
  opts: { fastMock?: boolean } = {},
): Promise<Services> {
  const dbh = await createDb(config)
  const bus = new InProcessEventBus()
  const auth = new AuthService(dbh)
  const projects = new ProjectService(dbh, config)
  const sessions = new SessionService(dbh, bus, config)
  const runtime = new AgentRuntime(config, dbh, opts)
  await runtime.loadPersisted()
  const orchestrator = new AgentOrchestrator({ dbh, config, sessions, projects, runtime })
  const merge = new MergeService({ dbh, projects, sessions, runtime })
  const ghost = new GhostCollaborator({ dbh, projects, sessions, orchestrator })
  const hub = new Hub({ dbh, bus, sessions, projects, orchestrator })

  return {
    config,
    dbh,
    bus,
    auth,
    projects,
    sessions,
    orchestrator,
    merge,
    ghost,
    hub,
    runtime,
    close: async () => {
      await dbh.close()
    },
  }
}
