import { eq } from 'drizzle-orm'
import type { AgentOrchestrator } from '../agent/orchestrator'
import type { DbHandle } from '../db/client'
import type { ProjectService } from '../projects/service'
import type { SessionService } from '../sessions/service'

/**
 * The ghost collaborator: a server-side player that drives a real session as
 * the first seeded founder, feeding scripted user messages through the exact
 * same handleUserMessage entrypoint as a human — no special casing anywhere
 * in the pipeline. Lets one person demo live spectating and forking solo.
 */
export class GhostCollaborator {
  private activeByProject = new Set<string>()

  constructor(
    private deps: {
      dbh: DbHandle
      projects: ProjectService
      sessions: SessionService
      orchestrator: AgentOrchestrator
    },
  ) {}

  isActive(projectId: string): boolean {
    return this.activeByProject.has(projectId)
  }

  async start(projectId: string, moduleId?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
    const { dbh, projects, sessions, orchestrator } = this.deps
    if (this.activeByProject.has(projectId)) {
      return { ok: false, error: 'A simulated teammate is already working in this project' }
    }

    const ghostUser = await this.findGhostUser()
    if (!ghostUser) return { ok: false, error: 'No seeded user available to play the teammate' }

    const modules = await projects.listModules(projectId)
    const module =
      (moduleId ? modules.find((m) => m.id === moduleId) : undefined) ??
      modules.find((m) => /land/i.test(m.name)) ??
      modules[0]
    if (!module) return { ok: false, error: 'This project has no modules yet' }

    const isMember = await projects.isMember(projectId, ghostUser.id)
    if (!isMember) return { ok: false, error: `${ghostUser.name} is not a member of this project` }

    const session = await sessions.createSession(module.id, ghostUser)
    this.activeByProject.add(projectId)

    void this.runScript(projectId, session.id, ghostUser, scriptFor(module.name)).finally(() => {
      this.activeByProject.delete(projectId)
    })

    return { ok: true, sessionId: session.id }
  }

  private async runScript(
    projectId: string,
    sessionId: string,
    ghostUser: NonNullable<Awaited<ReturnType<GhostCollaborator['findGhostUser']>>>,
    script: string[],
  ): Promise<void> {
    const { sessions, orchestrator } = this.deps
    try {
      await sleep(1200)
      for (const message of script) {
        const session = await sessions.getSession(sessionId)
        if (!session || session.status === 'ended') return
        const res = await orchestrator.handleUserMessage(sessionId, ghostUser, message)
        if (!res.ok) return
        await res.done
        // a human pause between asks — long enough for spectators to fork mid-flight
        await sleep(2800 + Math.random() * 2200)
      }
      await sessions.endSession(sessionId)
    } catch (err) {
      console.error('[ghost] script failed:', err)
    }
  }

  private async findGhostUser() {
    const { db, t } = this.deps.dbh
    const byEmail = await db.select().from(t.users).where(eq(t.users.email, 'prithviraj@loom.dev'))
    if (byEmail[0]) return byEmail[0]
    const first = await db.select().from(t.users).orderBy(t.users.createdAt).limit(1)
    return first[0] ?? null
  }
}

function scriptFor(moduleName: string): string[] {
  if (/land/i.test(moduleName)) {
    return [
      "Let's build the landing page hero — big wordmark, a one-line pitch about the team wiki, and a waitlist form.",
      'Nice. Now add a features grid below the hero with three cards: capture, organization, and search.',
      'Finish it off with a footer — quick links and a copyright line.',
    ]
  }
  if (/auth/i.test(moduleName)) {
    return [
      'Start the auth flow with a clean sign-in screen — email, password, inline validation.',
      'Add a sign-up mode that toggles without a page reload.',
    ]
  }
  return [
    `Let's get a first version of ${moduleName} in place — something simple we can look at in a browser.`,
    'Good — now iterate on it with a second section that goes one level deeper.',
  ]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
