import fs from 'node:fs'
import path from 'node:path'
import { execa, type Options as ExecaOptions } from 'execa'

export interface GitAuthor {
  name: string
  email: string
}

export interface FileStat {
  path: string
  changeKind: 'create' | 'edit' | 'delete'
  additions: number
  deletions: number
}

export interface FileDiff extends FileStat {
  unifiedDiff: string
}

export interface CommitInfo {
  sha: string
  subject: string
  authorName: string
  date: string
}

const BASE_ARGS = ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']

/**
 * Thin wrapper over the real `git` binary. One instance per project repo.
 * Sessions never touch `repoPath` directly — each session gets its own
 * worktree via createWorktree(); `repoPath` itself is the `main` checkout,
 * which is also where merges run (nothing else ever writes there).
 */
export class GitService {
  constructor(readonly repoPath: string) {}

  private async run(args: string[], opts: { cwd?: string; env?: Record<string, string>; reject?: boolean } = {}) {
    const execaOpts: ExecaOptions = {
      cwd: opts.cwd ?? this.repoPath,
      env: { GIT_TERMINAL_PROMPT: '0', ...opts.env },
      reject: opts.reject ?? true,
    }
    return execa('git', [...BASE_ARGS, ...args], execaOpts)
  }

  private authorEnv(author: GitAuthor): Record<string, string> {
    return {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    }
  }

  static async initRepo(repoPath: string, readme: string, author: GitAuthor): Promise<GitService> {
    fs.mkdirSync(repoPath, { recursive: true })
    const git = new GitService(repoPath)
    await git.run(['init', '-b', 'main'])
    fs.writeFileSync(path.join(repoPath, 'README.md'), readme)
    await git.run(['add', '-A'])
    await git.run(['commit', '-m', 'Initial commit'], { env: git.authorEnv(author) })
    return git
  }

  async currentSha(ref = 'HEAD', cwd?: string): Promise<string> {
    const { stdout } = await this.run(['rev-parse', ref], { cwd })
    return String(stdout).trim()
  }

  async branchExists(name: string): Promise<boolean> {
    const { exitCode } = await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { reject: false })
    return exitCode === 0
  }

  /** Create a new branch at startPoint and check it out in a fresh worktree. */
  async createWorktree(worktreePath: string, branchName: string, startPoint: string): Promise<void> {
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
    await this.run(['worktree', 'add', '-b', branchName, worktreePath, startPoint])
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', worktreePath], { reject: false })
    await this.run(['worktree', 'prune'], { reject: false })
  }

  /** True if the working tree at cwd has uncommitted changes (staged, unstaged or untracked). */
  async isDirty(cwd: string): Promise<boolean> {
    const { stdout } = await this.run(['status', '--porcelain'], { cwd })
    return String(stdout).trim().length > 0
  }

  async stageAll(cwd: string): Promise<void> {
    await this.run(['add', '-A'], { cwd })
  }

  /** Per-file stats + unified diffs of everything currently staged at cwd. */
  async stagedDiffs(cwd: string): Promise<FileDiff[]> {
    const { stdout: statusOut } = await this.run(['diff', '--cached', '--name-status', '-M'], { cwd })
    const kinds = new Map<string, 'create' | 'edit' | 'delete'>()
    for (const line of String(statusOut).split('\n')) {
      if (!line.trim()) continue
      const [code, ...rest] = line.split('\t')
      const filePath = rest[rest.length - 1]
      if (!code || !filePath) continue
      const kind = code.startsWith('A') ? 'create' : code.startsWith('D') ? 'delete' : 'edit'
      kinds.set(filePath, kind)
    }

    const { stdout: numstatOut } = await this.run(['diff', '--cached', '--numstat', '-M'], { cwd })
    const diffs: FileDiff[] = []
    for (const line of String(numstatOut).split('\n')) {
      if (!line.trim()) continue
      const [a, d, ...rest] = line.split('\t')
      const filePath = rest[rest.length - 1]
      if (!filePath) continue
      const { stdout: diffOut } = await this.run(['diff', '--cached', '-M', '--', filePath], { cwd })
      diffs.push({
        path: filePath,
        changeKind: kinds.get(filePath) ?? 'edit',
        additions: a === '-' ? 0 : Number(a),
        deletions: d === '-' ? 0 : Number(d),
        unifiedDiff: truncateDiff(String(diffOut)),
      })
    }
    return diffs
  }

  async commit(cwd: string, message: string, author: GitAuthor): Promise<string> {
    await this.run(['commit', '-m', message], { cwd, env: this.authorEnv(author) })
    return this.currentSha('HEAD', cwd)
  }

  async log(ref: string, limit = 50): Promise<CommitInfo[]> {
    const { stdout } = await this.run([
      'log',
      `-${limit}`,
      '--pretty=format:%H%x1f%s%x1f%an%x1f%aI',
      ref,
      '--',
    ])
    return String(stdout)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject, authorName, date] = line.split('\x1f')
        return { sha: sha ?? '', subject: subject ?? '', authorName: authorName ?? '', date: date ?? '' }
      })
  }

  async aheadBehind(branch: string, base = 'main'): Promise<{ ahead: number; behind: number }> {
    const { stdout } = await this.run(['rev-list', '--left-right', '--count', `${base}...${branch}`])
    const [behind, ahead] = String(stdout).trim().split(/\s+/).map(Number)
    return { ahead: ahead ?? 0, behind: behind ?? 0 }
  }

  async listSessionBranches(): Promise<string[]> {
    const { stdout } = await this.run(['branch', '--list', 'session/*', '--format=%(refname:short)'])
    return String(stdout).split('\n').map((s) => s.trim()).filter(Boolean)
  }

  /** File contents at a ref ("<sha>:<path>"). */
  async showFile(ref: string, filePath: string): Promise<string> {
    const { stdout } = await this.run(['show', `${ref}:${filePath}`])
    return String(stdout)
  }

  /** Flat list of file paths at a ref. */
  async listFilesAtRef(ref: string): Promise<string[]> {
    const { stdout } = await this.run(['ls-tree', '-r', '--name-only', ref])
    return String(stdout).split('\n').map((s) => s.trim()).filter(Boolean)
  }

  /** Full unified diff of one commit vs its parent. */
  async diffForCommit(sha: string): Promise<string> {
    const { stdout } = await this.run(['show', '--format=', '--patch', sha])
    return truncateDiff(String(stdout), 200_000)
  }

  /**
   * Merge `branch` into main. Runs in repoPath, which is the main checkout.
   * Returns conflicted file paths (empty = clean merge, sha set).
   */
  async mergeIntoMain(
    branch: string,
    message: string,
    author: GitAuthor,
  ): Promise<{ ok: boolean; sha: string | null; conflicts: string[] }> {
    await this.run(['checkout', 'main'], { reject: false })
    const res = await this.run(['merge', '--no-ff', branch, '-m', message], {
      env: this.authorEnv(author),
      reject: false,
    })
    if (res.exitCode === 0) {
      return { ok: true, sha: await this.currentSha(), conflicts: [] }
    }
    const { stdout } = await this.run(['diff', '--name-only', '--diff-filter=U'], { reject: false })
    const conflicts = String(stdout).split('\n').map((s) => s.trim()).filter(Boolean)
    return { ok: false, sha: null, conflicts }
  }

  async abortMerge(): Promise<void> {
    await this.run(['merge', '--abort'], { reject: false })
  }

  /** During a conflicted merge: take the incoming branch's side for all conflicts. */
  async resolveConflictsTheirs(conflicts: string[]): Promise<void> {
    for (const file of conflicts) {
      await this.run(['checkout', '--theirs', '--', file], { reject: false })
    }
    await this.run(['add', '-A'])
  }

  async readConflictedFile(filePath: string): Promise<string> {
    return fs.readFileSync(path.join(this.repoPath, filePath), 'utf8')
  }

  async writeResolvedFile(filePath: string, content: string): Promise<void> {
    fs.writeFileSync(path.join(this.repoPath, filePath), content)
    await this.run(['add', '--', filePath])
  }

  async commitMerge(message: string, author: GitAuthor): Promise<string> {
    await this.run(['commit', '--no-edit', '-m', message], { env: this.authorEnv(author) })
    return this.currentSha()
  }

  /** Stats for a commit: files + additions/deletions (for change records on merges). */
  async commitStats(sha: string): Promise<FileStat[]> {
    const { stdout: numstat } = await this.run(['show', '--format=', '--numstat', sha])
    const { stdout: status } = await this.run(['show', '--format=', '--name-status', sha])
    const kinds = new Map<string, 'create' | 'edit' | 'delete'>()
    for (const line of String(status).split('\n')) {
      if (!line.trim()) continue
      const [code, ...rest] = line.split('\t')
      const filePath = rest[rest.length - 1]
      if (!code || !filePath) continue
      kinds.set(filePath, code.startsWith('A') ? 'create' : code.startsWith('D') ? 'delete' : 'edit')
    }
    const stats: FileStat[] = []
    for (const line of String(numstat).split('\n')) {
      if (!line.trim()) continue
      const [a, d, ...rest] = line.split('\t')
      const filePath = rest[rest.length - 1]
      if (!filePath) continue
      stats.push({
        path: filePath,
        changeKind: kinds.get(filePath) ?? 'edit',
        additions: a === '-' ? 0 : Number(a),
        deletions: d === '-' ? 0 : Number(d),
      })
    }
    return stats
  }
}

function truncateDiff(diff: string, max = 50_000): string {
  if (diff.length <= max) return diff
  return diff.slice(0, max) + '\n… (diff truncated)'
}
