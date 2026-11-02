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
import { DbOutboxBus } from './realtime/dbBus'
import { Hub } from './realtime/hub'
import { DbCoordination, MemoryCoordination, type Coordination } from './realtime/coordination'
import { RadarService } from './coord/radar'
import { LiveMainService } from './coord/liveMain'
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
  coord: Coordination
  radar: RadarService
  liveMain: LiveMainService
  close(): Promise<void>
}

export async function createServices(
  config: ServerConfig,
  opts: { fastMock?: boolean } = {},
): Promise<Services> {
  const dbh = await createDb(config)
  // C10 — Redis-backed bus when REDIS_URL is set; in-process by default
  // serverless: the DB outbox (read by long-polling clients on any instance)
  const bus: EventBus =
    config.platform === 'serverless' ? new DbOutboxBus(dbh) : config.redisUrl ? new RedisEventBus(config.redisUrl) : new InProcessEventBus()
  const auth = new AuthService(dbh)
  const projects = new ProjectService(dbh, config)
  const sessions = new SessionService(dbh, bus, config)
  const runtime = new AgentRuntime(config, dbh, opts)
  await runtime.loadPersisted()
  // serverless: many instances share turn leases, stop requests and handoffs via the DB
  const coord: Coordination = config.platform === 'serverless' ? new DbCoordination(dbh) : new MemoryCoordination()
  // the coordination radar: who is changing what, and would it merge (any instance can answer)
  const radar: RadarService = new RadarService({
    dbh,
    config,
    projects,
    sessions,
    isWorking: async (id) => (await coord.get(`turn:${id}`)) !== null,
    isLocalTurn: (id: string): boolean => orchestrator.hasLocalTurn(id),
  })
  const orchestrator: AgentOrchestrator = new AgentOrchestrator({ dbh, config, sessions, projects, runtime, coord, radar })
  const liveMain = new LiveMainService({ config, radar })
  const merge = new MergeService({ dbh, projects, sessions, runtime, onMainMoved: (id) => radar.invalidate(id) })
  const ghost = new GhostCollaborator({ dbh, projects, sessions, orchestrator, bus })
  const notifications = new NotificationService(dbh, bus)
  const hub = new Hub({ dbh, bus, sessions, projects, orchestrator, notifications, coord })

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
    coord,
    radar,
    liveMain,
    close: async () => {
      if (bus instanceof RedisEventBus) await bus.close()
      await bus.flush?.()
      await dbh.close()
    },
  }
}
