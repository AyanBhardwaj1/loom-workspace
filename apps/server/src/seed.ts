import { eq } from 'drizzle-orm'
import { BRAND } from '@loom/shared'
import { ulid } from 'ulid'
import { AuthService } from './auth/service'
import { createDb } from './db/client'
import { loadConfig } from './env'
import { GitService } from './git/gitService'
import path from 'node:path'
import fs from 'node:fs'

/**
 * Seeds the five founders and the "Nimbus" demo project (team wiki app) with
 * four modules and an initialized git repo. Idempotent: safe to re-run.
 */
async function seed(): Promise<void> {
  const config = loadConfig()
  const dbh = await createDb(config)
  const { db, t } = dbh
  const auth = new AuthService(dbh)

  const founders = [
    { name: 'Prithviraj', email: 'prithviraj@loom.dev', avatarColor: '#8FA8E8' },
    { name: 'Ayan', email: 'ayan@loom.dev', avatarColor: '#9C8FF2' },
    { name: 'Sai', email: 'sai@loom.dev', avatarColor: '#7FBF9E' },
    { name: 'Ashwin', email: 'ashwin@loom.dev', avatarColor: '#D9A87C' },
    { name: 'Aarush', email: 'aarush@loom.dev', avatarColor: '#C98FB8' },
  ]

  const password = 'loom-demo'
  const passwordHash = await auth.hashPassword(password)
  const userIds: string[] = []

  for (const founder of founders) {
    const existing = await db.select().from(t.users).where(eq(t.users.email, founder.email))
    if (existing[0]) {
      userIds.push(existing[0].id)
      continue
    }
    const id = ulid()
    await db.insert(t.users).values({
      id,
      name: founder.name,
      email: founder.email,
      passwordHash,
      avatarColor: founder.avatarColor,
      createdAt: new Date().toISOString(),
    })
    userIds.push(id)
    console.log(`  + user ${founder.name} <${founder.email}>`)
  }

  const existingProject = await db.select().from(t.projects).where(eq(t.projects.name, 'Nimbus'))
  if (existingProject[0]) {
    console.log('  = project Nimbus already seeded')
    await dbh.close()
    console.log('\nSeed complete (nothing new to do).')
    return
  }

  const projectId = ulid()
  const repoPath = path.join(config.dataDir, 'projects', projectId, 'repo')
  fs.mkdirSync(path.dirname(repoPath), { recursive: true })
  await GitService.initRepo(
    repoPath,
    `# Nimbus

A team wiki app that writes itself — capture decisions where they happen and
find them when it matters.

This repo is built collaboratively through ${BRAND}: every commit was made by an
AI coding agent driven by a team member in a live, forkable session.
`,
    { name: founders[0]!.name, email: founders[0]!.email },
  )

  const now = new Date().toISOString()
  await db.insert(t.projects).values({
    id: projectId,
    name: 'Nimbus',
    description: 'A team wiki app that writes itself',
    repoPath,
    createdBy: userIds[0]!,
    createdAt: now,
  })
  for (const userId of userIds) {
    await db.insert(t.projectMembers).values({ projectId, userId })
  }

  const modules = [
    { name: 'Landing page', emoji: '🏠', status: 'building', description: 'Public marketing page with hero and waitlist' },
    { name: 'Auth flow', emoji: '🔐', status: 'idea', description: 'Sign in, sign up, and workspace access' },
    { name: 'Editor', emoji: '📝', status: 'building', description: 'The collaborative wiki page editor' },
    { name: 'Notifications', emoji: '🔔', status: 'idea', description: 'Toasts, mentions and digest emails' },
  ]
  for (let i = 0; i < modules.length; i++) {
    const m = modules[i]!
    await db.insert(t.modules).values({
      id: ulid(),
      projectId,
      name: m.name,
      description: m.description,
      emoji: m.emoji,
      status: m.status,
      sortOrder: i,
      createdAt: now,
    })
  }

  console.log(`  + project Nimbus (${projectId}) with ${modules.length} modules, repo at ${repoPath}`)
  await dbh.close()
  console.log(`
Seed complete.

  Demo logins (password: ${password})
${founders.map((f) => `    · ${f.name.padEnd(11)} ${f.email}`).join('\n')}

  In dev mode the login page also shows one-click buttons for these users.
`)
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
