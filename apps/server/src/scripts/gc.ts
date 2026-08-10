import fs from 'node:fs'
import { and, eq, lt, ne, isNotNull } from 'drizzle-orm'
import { loadConfig } from '../env'
import { createDb, type DbHandle } from '../db/client'
import { GitService } from '../git/gitService'

/**
 * C11 — worktree GC: prune git worktrees for sessions that ENDED more than
 * N days ago. Branches are never touched — history stays forkable; only the
 * working-copy directory is reclaimed. `--dry-run` logs without removing.
 *
 *   pnpm gc            # prune (default 14 days)
 *   pnpm gc --dry-run
 *   LOOM_GC_DAYS=30 pnpm gc
 */
export async function runWorktreeGc(
  dbh: DbHandle,
  opts: { days?: number; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<{ candidates: number; removed: number }> {
  const { db, t } = dbh
  const days = opts.days ?? Number(process.env.LOOM_GC_DAYS ?? 14)
  const dryRun = opts.dryRun ?? false
  const log = opts.log ?? ((l: string) => console.log(l))
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const rows = await db
    .select()
    .from(t.sessions)
    .where(and(eq(t.sessions.status, 'ended'), lt(t.sessions.lastEventAt, cutoff), isNotNull(t.sessions.worktreePath), ne(t.sessions.worktreePath, '')))

  let removed = 0
  for (const session of rows) {
    if (!fs.existsSync(session.worktreePath)) continue
    const projectRows = await db.select().from(t.projects).where(eq(t.projects.id, session.projectId))
    const repoPath = projectRows[0]?.repoPath
    if (dryRun) {
      log(`[gc] would remove worktree ${session.worktreePath} (session ${session.id}, ended ${session.lastEventAt})`)
      removed++
      continue
    }
    try {
      if (repoPath) {
        await new GitService(repoPath).removeWorktree(session.worktreePath)
      } else {
        fs.rmSync(session.worktreePath, { recursive: true, force: true })
      }
      log(`[gc] removed worktree ${session.worktreePath} (session ${session.id})`)
      removed++
    } catch (err) {
      log(`[gc] failed on ${session.worktreePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  log(`[gc] ${rows.length} candidate${rows.length === 1 ? '' : 's'}, ${removed} ${dryRun ? 'would be ' : ''}removed (ended > ${days}d)`)
  return { candidates: rows.length, removed }
}

// CLI entry
const isMain = process.argv[1]?.endsWith('gc.ts') || process.argv[1]?.endsWith('gc.js')
if (isMain) {
  void (async () => {
    const config = loadConfig()
    const dbh = await createDb(config)
    try {
      await runWorktreeGc(dbh, { dryRun: process.argv.includes('--dry-run') })
    } finally {
      await dbh.close()
    }
  })()
}
