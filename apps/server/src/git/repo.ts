import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import { DbRepo } from './dbRepo'
import { GitService, type GitAuthor } from './gitService'

/**
 * What the app needs from a project repository. Two implementations:
 * GitService (the real `git` binary on a persistent disk — local, Docker,
 * VPS) and DbRepo (a tiny git in the database, materialized into tmp — for
 * serverless platforms like Vercel). Callers never know which they hold.
 */
export type Repo = Pick<
  GitService,
  | 'repoPath'
  | 'currentSha'
  | 'branchExists'
  | 'createWorktree'
  | 'removeWorktree'
  | 'isDirty'
  | 'stageAll'
  | 'stagedDiffs'
  | 'commit'
  | 'log'
  | 'aheadBehind'
  | 'listSessionBranches'
  | 'showFile'
  | 'listFilesAtRef'
  | 'diffForCommit'
  | 'mergeIntoMain'
  | 'abortMerge'
  | 'resolveConflictsTheirs'
  | 'readConflictedFile'
  | 'writeResolvedFile'
  | 'commitMerge'
  | 'commitStats'
  | 'ensureCheckout'
  | 'readTree'
  | 'mergeBase'
>

export interface RepoContext {
  config: ServerConfig
  dbh: DbHandle
}

export function openRepo(repoPath: string, ctx: RepoContext): Repo {
  return ctx.config.platform === 'serverless' ? new DbRepo(repoPath, { dbh: ctx.dbh, dataDir: ctx.config.dataDir }) : new GitService(repoPath)
}

export async function initRepo(repoPath: string, readme: string, author: GitAuthor, ctx: RepoContext): Promise<Repo> {
  return ctx.config.platform === 'serverless'
    ? DbRepo.initRepo(repoPath, readme, author, { dbh: ctx.dbh, dataDir: ctx.config.dataDir })
    : GitService.initRepo(repoPath, readme, author)
}
