import { AgentRuntime } from './agent/runtime'
import { AgentOrchestrator } from './agent/orchestrator'
import { AuthService } from './auth/service'
import { createDb, type DbHandle } from './db/client'
import type { ServerConfig } from './env'
import { GhostCollaborator } from './ghost/ghost'
import { MergeService } from './git/mergeService'
import { NotificationService } from './notifications/service'
import { ProjectService } from './projects/service'
import { InProcessEventBus, type EventBus } from './realtime/bus'
import { RedisEventBus } from './realtime/redisBus'
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
  notifications: NotificationService
  runtime: AgentRuntime
  close(): Promise<void>
}

export async function createServices(
  config: ServerConfig,
  opts: { fastMock?: boolean } = {},
): Promise<Services> {
  const dbh = await createDb(config)
  // C10 — Redis-backed bus when REDIS_URL is set; in-process by default
  const bus: EventBus = config.redisUrl ? new RedisEventBus(config.redisUrl) : new InProcessEventBus()
  const auth = new AuthService(dbh)
  const projects = new ProjectService(dbh, config)
  const sessions = new SessionService(dbh, bus, config)
  const runtime = new AgentRuntime(config, dbh, opts)
  await runtime.loadPersisted()
  const orchestrator = new AgentOrchestrator({ dbh, config, sessions, projects, runtime })
  const merge = new MergeService({ dbh, projects, sessions, runtime })
  const ghost = new GhostCollaborator({ dbh, projects, sessions, orchestrator })
  const notifications = new NotificationService(dbh, bus)
  const hub = new Hub({ dbh, bus, sessions, projects, orchestrator, notifications })

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
    notifications,
    runtime,
    close: async () => {
      if (bus instanceof RedisEventBus) await bus.close()
      await dbh.close()
    },
  }
}
