import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { evaluateMergeGate } from '@loom/shared'
import type { BranchInfo, ContributionRow, ProjectDetail, ProjectLedger, SpendRow } from '@loom/shared'
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
    const policy = await projects.getPolicy(id)
    const memberCount = await projects.memberCount(id)
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
      const gate = session
        ? evaluateMergeGate({
            events: await sessions.getEvents(session.id, 0),
            driverUserId: session.driverUserId,
            mergerUserId: req.currentUser.id,
            memberCount,
            mode: policy.mergeGate,
          })
        : null
      out.push({
        gate,
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

  /**
   * The ledger: spend attributed to whoever was driving when it was spent
   * (handoffs move the meter), grouped by member, module and session — and
   * a per-person record of what everyone contributed, straight from the logs.
   */
  app.get('/api/projects/:id/ledger', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const { db, t } = dbh
    const sessionRows = await db.select().from(t.sessions).where(eq(t.sessions.projectId, id))
    const memberRows = await db
      .select({ id: t.users.id, name: t.users.name, avatarColor: t.users.avatarColor })
      .from(t.projectMembers)
      .innerJoin(t.users, eq(t.projectMembers.userId, t.users.id))
      .where(eq(t.projectMembers.projectId, id))
    const people = new Map(memberRows.map((u) => [u.id, u]))
    const modules = new Map((await projects.listModules(id)).map((m) => [m.id, m.name]))
    const spend = { member: new Map<string, SpendRow>(), module: new Map<string, SpendRow>(), session: new Map<string, SpendRow>() }
    const add = (bucket: Map<string, SpendRow>, key: string, label: string, cost: number, tokens: number, color?: string) => {
      const row = bucket.get(key) ?? { key, label, color, costUsd: 0, tokens: 0, turns: 0 }
      row.costUsd += cost
      row.tokens += tokens
      row.turns += 1
      bucket.set(key, row)
    }
    const contrib = new Map<string, ContributionRow>()
    const c = (userId: string | null | undefined) => {
      if (!userId || !people.has(userId)) return null
      let row = contrib.get(userId)
      if (!row) {
        const u = people.get(userId)!
        row = { userId, name: u.name, avatarColor: u.avatarColor, prompts: 0, steers: 0, suggestions: 0, suggestionsAccepted: 0, verdicts: 0, failsCaught: 0, approvals: 0, comments: 0, forks: 0, merges: 0 }
        contrib.set(userId, row)
      }
      return row
    }
    for (const s of sessionRows) {
      const events = await sessions.getEvents(s.id, 0)
      // the driver at the start of the log: before the first handoff, the wheel was with its previous driver
      const firstHandoff = events.find((e) => e.type === 'status' && e.payload.newDriverUserId)
      let driver = firstHandoff && firstHandoff.type === 'status' && firstHandoff.payload.previousDriverUserId ? firstHandoff.payload.previousDriverUserId : s.driverUserId
      const accepted = new Set(events.flatMap((e) => (e.type === 'suggestion_decision' && e.payload.decision === 'accepted' ? [e.payload.suggestionId] : [])))
      const plans = new Map(events.flatMap((e) => (e.type === 'test_plan' ? [[e.payload.planId, e] as const] : [])))
      for (const e of events) {
        if (e.type === 'status' && e.payload.newDriverUserId) driver = e.payload.newDriverUserId
        if (e.type === 'fork_marker') continue
        switch (e.type) {
          case 'usage': {
            const tokens = e.payload.inputTokens + e.payload.outputTokens
            const u = people.get(driver)
            add(spend.member, driver, u?.name ?? 'Former member', e.payload.costUsd, tokens, u?.avatarColor)
            add(spend.module, s.moduleId, modules.get(s.moduleId) ?? 'Module', e.payload.costUsd, tokens)
            add(spend.session, s.id, s.title, e.payload.costUsd, tokens)
            break
          }
          case 'user_message': {
            const r = c(driver)
            if (r) r.prompts += 1
            break
          }
          case 'steer': {
            const r = c(e.payload.byUserId)
            if (r) r.steers += 1
            break
          }
          case 'suggestion': {
            const r = c(e.payload.suggesterUserId)
            if (r) {
              r.suggestions += 1
              if (accepted.has(e.payload.suggestionId)) r.suggestionsAccepted += 1
            }
            break
          }
          case 'test_verdict': {
            const r = c(e.payload.byUserId)
            if (r && plans.has(e.payload.planId)) {
              r.verdicts += 1
              if (e.payload.verdict === 'fail') r.failsCaught += 1
            }
            break
          }
          case 'approval_decision': {
            const r = c(e.payload.byUserId)
            if (r) r.approvals += 1
            break
          }
          case 'annotation': {
            const r = c(e.payload.authorUserId)
            if (r && e.payload.kind === 'comment') r.comments += 1
            break
          }
        }
      }
      if (s.parentSessionId) {
        const r = c(s.driverUserId)
        if (r) r.forks += 1
      }
    }
    const changeRows = await db.select().from(t.changes).where(eq(t.changes.projectId, id))
    for (const ch of changeRows) {
      if (ch.branchName !== 'main') continue
      const r = c(ch.authorUserId)
      if (r) r.merges += 1
    }
    const sorted = (m: Map<string, SpendRow>) => [...m.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
    const byMember = sorted(spend.member)
    const ledger: ProjectLedger = {
      totalUsd: byMember.reduce((n, r) => n + r.costUsd, 0),
      totalTokens: byMember.reduce((n, r) => n + r.tokens, 0),
      byMember,
      byModule: sorted(spend.module),
      bySession: sorted(spend.session).slice(0, 12),
      contributions: [...contrib.values()].sort((a, b) => b.prompts + b.verdicts + b.steers + b.suggestions - (a.prompts + a.verdicts + a.steers + a.suggestions)),
    }
    return ledger
  })

  // the room's rules: anyone can see them; the owner sets the gate and guards; any member can freeze
  app.get('/api/projects/:id/policy', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    return { policy: await projects.getPolicy(id), isOwner: project.createdBy === req.currentUser.id }
  })

  app.put('/api/projects/:id/policy', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const body = parseBody(
      z.object({
        mergeGate: z.enum(['enforce', 'warn', 'off']).optional(),
        guardedActions: z.boolean().optional(),
        protectedPaths: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
        frozen: z.boolean().optional(),
      }),
      req.body,
      reply,
    )
    if (!body) return
    const current = await projects.getPolicy(id)
    const isOwner = project.createdBy === req.currentUser.id
    const ownerOnly = body.mergeGate !== undefined || body.guardedActions !== undefined || body.protectedPaths !== undefined
    if (ownerOnly && !isOwner) return reply.code(403).send({ error: 'Only the project owner changes the merge gate and guards' })
    const next = {
      ...current,
      ...(body.mergeGate !== undefined ? { mergeGate: body.mergeGate } : {}),
      ...(body.guardedActions !== undefined ? { guardedActions: body.guardedActions } : {}),
      ...(body.protectedPaths !== undefined ? { protectedPaths: body.protectedPaths } : {}),
      ...(body.frozen !== undefined ? { frozen: body.frozen, frozenBy: body.frozen ? req.currentUser.name : null } : {}),
    }
    await projects.setPolicy(id, next)
    if (body.frozen !== undefined && body.frozen !== current.frozen) {
      services.sessions.publishProjectUpdate(id, { kind: 'policy', frozen: next.frozen, by: req.currentUser.name })
    }
    return { policy: next, isOwner }
  })

  app.post('/api/projects/:id/merge', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const project = await memberProject(id, req.currentUser.id, reply)
    if (!project) return
    const body = parseBody(
      z.object({ branchName: z.string().min(1), override: z.object({ reason: z.string().trim().min(4).max(300) }).optional() }),
      req.body,
      reply,
    )
    if (!body) return
    if (!/^session\//.test(body.branchName)) {
      return reply.code(400).send({ error: 'Only session branches can be merged' })
    }
    // the verified-to-merge gate: enforced here, shown everywhere
    const owning = await services.sessions.getSessionByBranch(id, body.branchName)
    let override: { by: string; reason: string } | undefined
    let unverified: string[] | undefined
    if (owning) {
      const policy = await projects.getPolicy(id)
      const gate = evaluateMergeGate({
        events: await sessions.getEvents(owning.id, 0),
        driverUserId: owning.driverUserId,
        mergerUserId: req.currentUser.id,
        memberCount: await projects.memberCount(id),
        mode: policy.mergeGate,
      })
      if (gate.mode === 'warn') {
        const open = gate.checks.filter((c) => c.status === 'fail').map((c) => c.label.toLowerCase())
        if (open.length > 0) unverified = open
      }
      if (!gate.ok) {
        // only the project owner may override, and the reason is written into history
        if (!body.override) return reply.code(409).send({ error: 'This work isn’t verified for main yet', gate })
        if (project.createdBy !== req.currentUser.id) {
          return reply.code(403).send({ error: 'Only the project owner can override the merge gate', gate })
        }
        override = { by: req.currentUser.name, reason: body.override.reason }
      }
    }
    const result = await merge.mergeBranch(id, body.branchName, req.currentUser, { override, unverified })
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
