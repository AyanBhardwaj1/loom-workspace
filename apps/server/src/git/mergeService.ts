import { and, eq } from 'drizzle-orm'
import type { MergeResult } from '@loom/shared'
import type { AgentRuntime } from '../agent/runtime'
import type { DbHandle } from '../db/client'
import type { ProjectService } from '../projects/service'
import type { SessionService } from '../sessions/service'

type UserRow = typeof import('../db/schema.sqlite').users.$inferSelect

/**
 * Merge a session branch into main. Clean merges just merge; conflicted ones
 * are resolved by the agent in real mode, or by taking the incoming side in
 * mock mode — and the outcome is reported honestly either way.
 * Merges run in the project's main checkout (repoPath), which nothing else
 * ever writes to.
 */
export class MergeService {
  constructor(
    private deps: {
      dbh: DbHandle
      projects: ProjectService
      sessions: SessionService
      runtime: AgentRuntime
    },
  ) {}

  async mergeBranch(projectId: string, branchName: string, requestedBy: UserRow): Promise<MergeResult> {
    const { dbh, projects, sessions } = this.deps
    const conflictResolver = this.deps.runtime.conflictResolver
    const { db, t } = dbh
    const project = await projects.getProject(projectId)
    if (!project) return { ok: false, merged: false, hadConflicts: false, message: 'Project not found', changeId: null }
    const git = projects.gitFor(project)

    if (!(await git.branchExists(branchName))) {
      return { ok: false, merged: false, hadConflicts: false, message: `Branch ${branchName} not found`, changeId: null }
    }

    const owningSessions = await db
      .select()
      .from(t.sessions)
      .where(and(eq(t.sessions.projectId, projectId), eq(t.sessions.branchName, branchName)))
    const owningSession = owningSessions[0] ?? null
    const driver = owningSession
      ? (await db.select().from(t.users).where(eq(t.users.id, owningSession.driverUserId)))[0]
      : null
    const module = owningSession ? await projects.getModule(owningSession.moduleId) : null

    const beforeSha = await git.currentSha('main')
    const author = { name: requestedBy.name, email: requestedBy.email }
    const res = await git.mergeIntoMain(branchName, `Merge ${branchName} into main`, author)

    let sha: string
    let hadConflicts = false
    let conflictNote = ''

    if (res.ok) {
      sha = res.sha!
      if (sha === beforeSha) {
        return {
          ok: true,
          merged: false,
          hadConflicts: false,
          message: 'main already has everything from this branch — nothing to merge.',
          changeId: null,
        }
      }
    } else {
      hadConflicts = true
      const resolvedByAgent: string[] = []
      if (conflictResolver) {
        for (const file of res.conflicts) {
          const conflicted = await git.readConflictedFile(file)
          const resolved = await conflictResolver(file, conflicted)
          if (resolved !== null) {
            await git.writeResolvedFile(file, resolved)
            resolvedByAgent.push(file)
          }
        }
      }
      const unresolved = res.conflicts.filter((f) => !resolvedByAgent.includes(f))
      if (unresolved.length > 0) {
        await git.resolveConflictsTheirs(unresolved)
      }
      try {
        sha = await git.commitMerge(`Merge ${branchName} into main (conflicts resolved)`, author)
      } catch (err) {
        await git.abortMerge()
        return {
          ok: false,
          merged: false,
          hadConflicts: true,
          message: `Merge failed and was aborted: ${err instanceof Error ? err.message : String(err)}`,
          changeId: null,
        }
      }
      conflictNote =
        conflictResolver && resolvedByAgent.length > 0
          ? ` Both sessions had touched the same ${res.conflicts.length === 1 ? 'file' : 'files'} (${res.conflicts.join(', ')}), so the agent combined the two versions.`
          : ` Both sessions had touched the same ${res.conflicts.length === 1 ? 'file' : 'files'} (${res.conflicts.join(', ')}); the newer branch's version was kept.`
    }

    const stats = await git.commitStats(sha)
    const additions = stats.reduce((n, s) => n + s.additions, 0)
    const deletions = stats.reduce((n, s) => n + s.deletions, 0)
    const technicalSummary = `Merge ${branchName} into main (${stats.length} file${stats.length === 1 ? '' : 's'}, +${additions}/−${deletions})`
    const who = driver?.name ?? 'a teammate'
    const what = module ? `${module.emoji} ${module.name}` : 'their session'
    const plainExplanation = `${who}'s work on ${what} is now part of the main version of the project — everyone will build on top of it from here.${conflictNote}`

    let changeId: string | null = null
    if (owningSession) {
      const change = await projects.insertChange({
        projectId,
        sessionId: owningSession.id,
        commitSha: sha,
        branchName: 'main',
        technicalSummary,
        plainExplanation,
        filesChanged: stats,
        authorUserId: requestedBy.id,
      })
      changeId = change.id
      const [summary] = await projects.toChangeSummaries([change])
      if (summary) sessions.publishProjectUpdate(projectId, { kind: 'change', change: summary })
    }
    sessions.publishProjectUpdate(projectId, {
      kind: 'merge',
      branchName,
      ok: true,
      message: hadConflicts ? 'Merged with conflicts resolved' : 'Merged cleanly',
    })

    return {
      ok: true,
      merged: true,
      hadConflicts,
      message: hadConflicts ? `Merged with conflicts resolved.${conflictNote}` : 'Merged cleanly into main.',
      changeId,
    }
  }
}
