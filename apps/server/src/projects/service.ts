import path from 'node:path'
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { BRAND } from '@loom/shared'
import { ulid } from 'ulid'
import type {
  ChangeSummary,
  ModuleDto,
  ModuleStatus,
  ProjectDetail,
  ProjectSummary,
  UserPublic,
} from '@loom/shared'
import { toPublicUser } from '../auth/service'
import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import { GitService } from '../git/gitService'

type ProjectRow = typeof import('../db/schema.sqlite').projects.$inferSelect
type ModuleRow = typeof import('../db/schema.sqlite').modules.$inferSelect
type ChangeRow = typeof import('../db/schema.sqlite').changes.$inferSelect
type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

export interface NewModuleInput {
  name: string
  description?: string
  emoji?: string
  status?: ModuleStatus
}

export class ProjectService {
  constructor(
    private dbh: DbHandle,
    private config: ServerConfig,
  ) {}

  async getProject(id: string): Promise<ProjectRow | null> {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.projects).where(eq(t.projects.id, id))
    return rows[0] ?? null
  }

  async getModule(id: string): Promise<ModuleRow | null> {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.modules).where(eq(t.modules.id, id))
    return rows[0] ?? null
  }

  async isMember(projectId: string, userId: string): Promise<boolean> {
    const { db, t } = this.dbh
    const rows = await db
      .select()
      .from(t.projectMembers)
      .where(and(eq(t.projectMembers.projectId, projectId), eq(t.projectMembers.userId, userId)))
    return rows.length > 0
  }

  async getMembers(projectId: string): Promise<UserPublic[]> {
    const { db, t } = this.dbh
    const rows = await db
      .select({ user: t.users })
      .from(t.projectMembers)
      .innerJoin(t.users, eq(t.projectMembers.userId, t.users.id))
      .where(eq(t.projectMembers.projectId, projectId))
    return rows.map((r) => toPublicUser(r.user))
  }

  async addMemberByEmail(projectId: string, email: string): Promise<UserPublic | null> {
    const { db, t } = this.dbh
    const users = await db.select().from(t.users).where(eq(t.users.email, email.trim().toLowerCase()))
    const user = users[0]
    if (!user) return null
    const already = await this.isMember(projectId, user.id)
    if (!already) {
      await db.insert(t.projectMembers).values({ projectId, userId: user.id })
    }
    return toPublicUser(user)
  }

  /**
   * Create a project: git-init its repo with a README initial commit on main,
   * add the creator as a member, scaffold default modules.
   */
  async createProject(name: string, description: string, creator: UserRow): Promise<ProjectRow> {
    const { db, t } = this.dbh
    const id = ulid()
    const repoPath = path.join(this.config.dataDir, 'projects', id, 'repo')
    await GitService.initRepo(repoPath, projectReadme(name, description), {
      name: creator.name,
      email: creator.email,
    })

    const now = new Date().toISOString()
    const project: ProjectRow = { id, name: name.trim(), description: description.trim(), repoPath, createdBy: creator.id, createdAt: now }
    await db.insert(t.projects).values(project)
    await db.insert(t.projectMembers).values({ projectId: id, userId: creator.id })

    const defaults: Array<{ name: string; description: string; emoji: string }> = [
      { name: 'Landing page', description: 'The public face of the product', emoji: '🏠' },
      { name: 'Core app', description: 'The heart of the product', emoji: '⚙️' },
    ]
    for (let i = 0; i < defaults.length; i++) {
      const d = defaults[i]!
      await db.insert(t.modules).values({
        id: ulid(),
        projectId: id,
        name: d.name,
        description: d.description,
        emoji: d.emoji,
        status: 'idea',
        sortOrder: i,
        createdAt: now,
      })
    }
    return project
  }

  async createModule(projectId: string, input: NewModuleInput): Promise<ModuleRow> {
    const { db, t } = this.dbh
    const rows = await db
      .select({ maxOrder: sql<number>`coalesce(max(${t.modules.sortOrder}), -1)` })
      .from(t.modules)
      .where(eq(t.modules.projectId, projectId))
    const module: ModuleRow = {
      id: ulid(),
      projectId,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      emoji: input.emoji?.trim() || '📦',
      status: input.status ?? 'idea',
      sortOrder: Number(rows[0]?.maxOrder ?? -1) + 1,
      createdAt: new Date().toISOString(),
    }
    await db.insert(t.modules).values(module)
    return module
  }

  async updateModule(
    moduleId: string,
    patch: Partial<Pick<ModuleRow, 'name' | 'description' | 'emoji' | 'status' | 'sortOrder'>>,
  ): Promise<ModuleRow | null> {
    const { db, t } = this.dbh
    await db.update(t.modules).set(patch).where(eq(t.modules.id, moduleId))
    return this.getModule(moduleId)
  }

  async listModules(projectId: string): Promise<ModuleRow[]> {
    const { db, t } = this.dbh
    return db.select().from(t.modules).where(eq(t.modules.projectId, projectId)).orderBy(t.modules.sortOrder)
  }

  async listProjectsForUser(userId: string): Promise<ProjectSummary[]> {
    const { db, t } = this.dbh
    const memberRows = await db
      .select({ project: t.projects })
      .from(t.projectMembers)
      .innerJoin(t.projects, eq(t.projectMembers.projectId, t.projects.id))
      .where(eq(t.projectMembers.userId, userId))
      .orderBy(desc(t.projects.createdAt))

    const out: ProjectSummary[] = []
    for (const { project } of memberRows) {
      const [moduleCount, members, activeCount, lastChange, lastSession] = await Promise.all([
        db
          .select({ n: sql<number>`count(*)` })
          .from(t.modules)
          .where(eq(t.modules.projectId, project.id)),
        this.getMembers(project.id),
        db
          .select({ n: sql<number>`count(*)` })
          .from(t.sessions)
          .where(and(eq(t.sessions.projectId, project.id), eq(t.sessions.status, 'active'))),
        db
          .select({ at: t.changes.createdAt })
          .from(t.changes)
          .where(eq(t.changes.projectId, project.id))
          .orderBy(desc(t.changes.createdAt))
          .limit(1),
        db
          .select({ at: t.sessions.lastEventAt })
          .from(t.sessions)
          .where(eq(t.sessions.projectId, project.id))
          .orderBy(desc(t.sessions.lastEventAt))
          .limit(1),
      ])
      const candidates = [lastChange[0]?.at, lastSession[0]?.at, project.createdAt].filter(
        (x): x is string => Boolean(x),
      )
      out.push({
        id: project.id,
        name: project.name,
        description: project.description,
        createdBy: project.createdBy,
        createdAt: project.createdAt,
        moduleCount: Number(moduleCount[0]?.n ?? 0),
        members,
        activeSessionCount: Number(activeCount[0]?.n ?? 0),
        lastActivityAt: candidates.sort().reverse()[0] ?? null,
      })
    }
    return out
  }

  toModuleDto(m: ModuleRow): ModuleDto {
    return {
      id: m.id,
      projectId: m.projectId,
      name: m.name,
      description: m.description,
      emoji: m.emoji,
      status: m.status as ModuleStatus,
      sortOrder: m.sortOrder,
      createdAt: m.createdAt,
    }
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  async insertChange(input: {
    projectId: string
    sessionId: string
    commitSha: string
    branchName: string
    technicalSummary: string
    plainExplanation: string
    filesChanged: Array<{ path: string; changeKind: 'create' | 'edit' | 'delete'; additions: number; deletions: number }>
    authorUserId: string
  }): Promise<ChangeRow> {
    const { db, t } = this.dbh
    const row: ChangeRow = {
      id: ulid(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      commitSha: input.commitSha,
      branchName: input.branchName,
      technicalSummary: input.technicalSummary,
      plainExplanation: input.plainExplanation,
      filesChanged: JSON.stringify(input.filesChanged),
      authorUserId: input.authorUserId,
      createdAt: new Date().toISOString(),
    }
    await db.insert(t.changes).values(row)
    return row
  }

  async getChange(changeId: string): Promise<ChangeRow | null> {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.changes).where(eq(t.changes.id, changeId))
    return rows[0] ?? null
  }

  async listChanges(projectId: string, opts: { limit?: number; before?: string } = {}): Promise<ChangeSummary[]> {
    const { db, t } = this.dbh
    const limit = Math.min(opts.limit ?? 50, 200)
    const where = opts.before
      ? and(eq(t.changes.projectId, projectId), lt(t.changes.createdAt, opts.before))
      : eq(t.changes.projectId, projectId)
    const rows = await db.select().from(t.changes).where(where).orderBy(desc(t.changes.createdAt)).limit(limit)
    return this.toChangeSummaries(rows)
  }

  async toChangeSummaries(rows: ChangeRow[]): Promise<ChangeSummary[]> {
    const { db, t } = this.dbh
    if (rows.length === 0) return []
    const userIds = [...new Set(rows.map((r) => r.authorUserId))]
    const sessionIds = [...new Set(rows.map((r) => r.sessionId))]
    const users = await db.select().from(t.users).where(inArray(t.users.id, userIds))
    const sessions = await db.select().from(t.sessions).where(inArray(t.sessions.id, sessionIds))
    const moduleIds = [...new Set(sessions.map((s) => s.moduleId))]
    const modules =
      moduleIds.length > 0 ? await db.select().from(t.modules).where(inArray(t.modules.id, moduleIds)) : []
    const userById = new Map(users.map((u) => [u.id, u]))
    const sessionById = new Map(sessions.map((s) => [s.id, s]))
    const moduleById = new Map(modules.map((m) => [m.id, m]))

    return rows.map((r) => {
      const author = userById.get(r.authorUserId)
      const session = sessionById.get(r.sessionId)
      const module = session ? moduleById.get(session.moduleId) : undefined
      let filesChanged: ChangeSummary['filesChanged'] = []
      try {
        filesChanged = JSON.parse(r.filesChanged)
      } catch {
        filesChanged = []
      }
      return {
        id: r.id,
        projectId: r.projectId,
        sessionId: r.sessionId,
        commitSha: r.commitSha,
        branchName: r.branchName,
        technicalSummary: r.technicalSummary,
        plainExplanation: r.plainExplanation,
        filesChanged,
        authorUserId: r.authorUserId,
        authorName: author?.name ?? 'Unknown',
        authorAvatarColor: author?.avatarColor ?? '#8b7cf6',
        moduleName: module?.name ?? null,
        moduleEmoji: module?.emoji ?? null,
        createdAt: r.createdAt,
      }
    })
  }

  gitFor(project: ProjectRow): GitService {
    return new GitService(project.repoPath)
  }
}

function projectReadme(name: string, description: string): string {
  return `# ${name}

${description}

Built collaboratively with ${BRAND} — every change in this repo was made
by an AI coding agent driven by a team member, in a forkable multiplayer session.
`
}
