import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { BranchInfo, ProjectDetail } from '@loom/shared'
import { moduleStatusSchema } from '@loom/shared'
import { eq } from 'drizzle-orm'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

const createProjectSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional().default(''),
})

const createModuleSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  emoji: z.string().max(8).optional(),
  status: moduleStatusSchema.optional(),
})

const patchModuleSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  emoji: z.string().max(8).optional(),
  status: moduleStatusSchema.optional(),
  sortOrder: z.number().int().optional(),
})

export async function projectRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const { projects, sessions, merge, dbh } = services
  const requireUser = makeRequireUser(services)

  /** membership guard; sends 403/404 and returns null when blocked */
  async function memberProject(projectId: string, userId: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) {
    const project = await projects.getProject(projectId)
    if (!project) {
      reply.code(404).send({ error: 'Project not found' })
      return null
    }
    if (!(await projects.isMember(projectId, userId))) {
      reply.code(403).send({ error: 'You are not a member of this project' })
      return null
    }
    return project
  }

  app.get('/api/projects', { preHandler: requireUser }, async (req) => {
    return { projects: await projects.listProjectsForUser(req.currentUser.id) }
  })

  app.post('/api/projects', { preHandler: requireUser }, async (req, reply) => {
    const body = parseBody(createProjectSchema, req.body, reply)
    if (!body) return
    const project = await projects.createProject(body.name, body.description, req.currentUser)
    return reply.code(201).send({ project: { id: project.id, name: project.name, description: project.description } })
  })

  app.get('/api/projects/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const [modules, members, activeSessions] = await Promise.all([
      projects.listModules(id),
      projects.getMembers(id),
      sessions.listActiveSessionsForProject(id),
    ])
    const detail: ProjectDetail = {
      id: project.id,
      name: project.name,
      description: project.description,
      createdBy: project.createdBy,
      createdAt: project.createdAt,
      members,
      modules: modules.map((m) => projects.toModuleDto(m)),
      activeSessions: await Promise.all(activeSessions.map((s) => sessions.toSummary(s))),
    }
    return detail
  })

  app.post('/api/projects/:id/modules', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const body = parseBody(createModuleSchema, req.body, reply)
    if (!body) return
    const module = await projects.createModule(id, body)
    sessions.publishProjectUpdate(id, {
      kind: 'module_updated',
      moduleId: module.id,
      name: module.name,
      emoji: module.emoji,
      status: module.status as 'idea' | 'building' | 'stable',
    })
    return reply.code(201).send({ module: projects.toModuleDto(module) })
  })

  app.patch('/api/modules/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = await projects.getModule(id)
    if (!existing) return reply.code(404).send({ error: 'Module not found' })
    if (!(await projects.isMember(existing.projectId, req.currentUser.id))) {
      return reply.code(403).send({ error: 'You are not a member of this project' })
    }
    const body = parseBody(patchModuleSchema, req.body, reply)
    if (!body) return
    const module = await projects.updateModule(id, body)
    if (!module) return reply.code(404).send({ error: 'Module not found' })
    sessions.publishProjectUpdate(existing.projectId, {
      kind: 'module_updated',
      moduleId: module.id,
      name: module.name,
      emoji: module.emoji,
      status: module.status as 'idea' | 'building' | 'stable',
    })
    return { module: projects.toModuleDto(module) }
  })

  app.post('/api/projects/:id/members', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const body = parseBody(z.object({ email: z.string().email() }), req.body, reply)
    if (!body) return
    const member = await projects.addMemberByEmail(id, body.email)
    if (!member) return reply.code(404).send({ error: 'No user with that email — they need to sign up first' })
    return { member }
  })

  app.get('/api/projects/:id/changes', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const query = req.query as { limit?: string; before?: string }
    const changes = await projects.listChanges(id, {
      limit: query.limit ? Number(query.limit) : undefined,
      before: query.before,
    })
    return { changes }
  })

  app.get('/api/changes/:id/diff', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const change = await projects.getChange(id)
    if (!change) return reply.code(404).send({ error: 'Change not found' })
    const project = await memberProject(change.projectId, req.currentUser.id, reply)
    if (!project) return
    const git = projects.gitFor(project)
    const [summary] = await projects.toChangeSummaries([change])
    try {
      const diff = await git.diffForCommit(change.commitSha)
      return { change: summary, diff }
    } catch {
      return { change: summary, diff: '(diff unavailable — the commit may have been rewritten)' }
    }
  })

  app.get('/api/projects/:id/files', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const query = req.query as { ref?: string }
    const ref = sanitizeRef(query.ref) ?? 'main'
    const git = projects.gitFor(project)
    try {
      return { ref, files: await git.listFilesAtRef(ref) }
    } catch {
      return reply.code(404).send({ error: `Unknown ref: ${ref}` })
    }
  })

  app.get('/api/projects/:id/file', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const query = req.query as { ref?: string; path?: string }
    const ref = sanitizeRef(query.ref) ?? 'main'
    if (!query.path) return reply.code(400).send({ error: 'path is required' })
    const git = projects.gitFor(project)
    try {
      const content = await git.showFile(ref, query.path)
      return { ref, path: query.path, content }
    } catch {
      return reply.code(404).send({ error: `Cannot read ${query.path} at ${ref}` })
    }
  })

  app.get('/api/projects/:id/branches', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const git = projects.gitFor(project)
    const { db, t } = dbh
    const branchNames = await git.listSessionBranches()
    const out: BranchInfo[] = []
    for (const branchName of branchNames) {
      const { ahead, behind } = await git.aheadBehind(branchName)
      const sessionRows = await db.select().from(t.sessions).where(eq(t.sessions.branchName, branchName))
      const session = sessionRows[0] ?? null
      let driverName: string | null = null
      let driverAvatarColor: string | null = null
      let moduleName: string | null = null
      let moduleEmoji: string | null = null
      if (session) {
        const driverRows = await db.select().from(t.users).where(eq(t.users.id, session.driverUserId))
        driverName = driverRows[0]?.name ?? null
        driverAvatarColor = driverRows[0]?.avatarColor ?? null
        const module = await projects.getModule(session.moduleId)
        moduleName = module?.name ?? null
        moduleEmoji = module?.emoji ?? null
      }
      let lastCommitSha: string | null = null
      try {
        lastCommitSha = await git.currentSha(branchName)
      } catch {
        lastCommitSha = null
      }
      out.push({
        branchName,
        aheadOfMain: ahead,
        behindMain: behind,
        sessionId: session?.id ?? null,
        sessionTitle: session?.title ?? null,
        driverName,
        driverAvatarColor,
        moduleName,
        moduleEmoji,
        lastCommitSha,
      })
    }
    return { branches: out }
  })

  app.post('/api/projects/:id/merge', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const body = parseBody(z.object({ branchName: z.string().min(1) }), req.body, reply)
    if (!body) return
    if (!/^session\//.test(body.branchName)) {
      return reply.code(400).send({ error: 'Only session branches can be merged' })
    }
    const result = await merge.mergeBranch(id, body.branchName, req.currentUser)
    // F13 — the branch's driver hears their work reached main
    if (result.ok) {
      const branchSession = await services.sessions.getSessionByBranch(id, body.branchName)
      if (branchSession && branchSession.driverUserId !== req.currentUser.id) {
        await services.notifications.create({
          userId: branchSession.driverUserId,
          kind: 'merge',
          text: `${req.currentUser.name} merged "${branchSession.title}" into main`,
          projectId: id,
          sessionId: branchSession.id,
        })
      }
    }
    return result
  })
}

/** Refs come from the client — keep them to plain sha/branch tokens. */
function sanitizeRef(ref: string | undefined): string | null {
  if (!ref) return null
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(ref) || ref.startsWith('-')) return null
  return ref
}
