import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { structuredPatch } from 'diff'
import { and, eq, inArray } from 'drizzle-orm'
import { merge as diff3Merge } from 'node-diff3'
import type { DbHandle } from '../db/client'
import type { CommitInfo, FileDiff, FileStat, GitAuthor } from './gitService'

/**
 * A tiny git, in the database — for platforms with no persistent disk and no
 * `git` binary (Vercel functions). Same surface as GitService, same
 * semantics the app relies on: content-addressed blobs, commits with trees
 * and parents, branch refs, worktrees (materialized into the local tmp dir
 * on demand, so the agent's file tools and the preview keep working on real
 * files), first-parent logs, ahead/behind, and a real three-way merge.
 *
 * Any instance can rebuild any checkout from the DB, so a turn, a preview
 * request and a merge may each land on a different function instance.
 */

type Tree = Record<string, string> // path → blob hash

interface CommitRow {
  sha: string
  tree: Tree
  parents: string[]
  message: string
  authorName: string
  authorEmail: string
  createdAt: string
}

const SKIP_DIRS = new Set(['.git', 'node_modules'])
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** per-instance: checkout path → the commit currently materialized there */
const materialized = new Map<string, string>()

export interface DbRepoDeps {
  dbh: DbHandle
  dataDir: string
}

export class DbRepo {
  readonly repoKey: string
  /** an in-progress conflicted merge (one request: merge → resolve → commit) */
  private pendingMerge: { branch: string; tree: Tree; conflicts: Map<string, string>; mainSha: string; branchSha: string } | null = null

  constructor(
    readonly repoPath: string,
    private deps: DbRepoDeps,
  ) {
    this.repoKey = this.key(repoPath)
  }

  /** dataDir-relative, so every instance (same dataDir) agrees on identities */
  private key(p: string): string {
    return path.relative(this.deps.dataDir, path.resolve(p)).split(path.sep).join('/')
  }

  private get db() {
    return this.deps.dbh.db
  }
  private get t() {
    return this.deps.dbh.t
  }

  // ------------------------------------------------------------- objects
  private async putBlobs(contents: Map<string, string>): Promise<void> {
    if (contents.size === 0) return
    const hashes = [...contents.keys()]
    const existing = new Set<string>()
    for (let i = 0; i < hashes.length; i += 200) {
      const rows = await this.db.select({ hash: this.t.vgitBlobs.hash }).from(this.t.vgitBlobs).where(inArray(this.t.vgitBlobs.hash, hashes.slice(i, i + 200)))
      for (const r of rows) existing.add(r.hash)
    }
    for (const [hash, content] of contents) {
      if (existing.has(hash)) continue
      await this.db.insert(this.t.vgitBlobs).values({ hash, content }).onConflictDoNothing()
    }
  }

  private async getBlobs(hashes: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const unique = [...new Set(hashes)]
    for (let i = 0; i < unique.length; i += 200) {
      const rows = await this.db.select().from(this.t.vgitBlobs).where(inArray(this.t.vgitBlobs.hash, unique.slice(i, i + 200)))
      for (const r of rows) out.set(r.hash, r.content)
    }
    return out
  }

  private async getCommit(sha: string): Promise<CommitRow | null> {
    const [row] = await this.db.select().from(this.t.vgitCommits).where(and(eq(this.t.vgitCommits.sha, sha), eq(this.t.vgitCommits.repo, this.repoKey)))
    if (!row) return null
    return { ...row, tree: JSON.parse(row.tree) as Tree, parents: JSON.parse(row.parents) as string[] }
  }

  private async allCommits(): Promise<Map<string, CommitRow>> {
    const rows = await this.db.select().from(this.t.vgitCommits).where(eq(this.t.vgitCommits.repo, this.repoKey))
    return new Map(rows.map((r) => [r.sha, { ...r, tree: JSON.parse(r.tree) as Tree, parents: JSON.parse(r.parents) as string[] }]))
  }

  private async writeCommit(tree: Tree, parents: string[], message: string, author: GitAuthor): Promise<string> {
    const createdAt = new Date().toISOString()
    const body = JSON.stringify({ tree, parents, message, author: author.name, email: author.email, createdAt, nonce: crypto.randomBytes(4).toString('hex') })
    const sha = crypto.createHash('sha1').update(body).digest('hex')
    await this.db.insert(this.t.vgitCommits).values({
      sha,
      repo: this.repoKey,
      tree: JSON.stringify(tree),
      parents: JSON.stringify(parents),
      message,
      authorName: author.name,
      authorEmail: author.email,
      createdAt,
    })
    return sha
  }

  // ---------------------------------------------------------------- refs
  private async refSha(name: string): Promise<string | null> {
    const [row] = await this.db.select().from(this.t.vgitRefs).where(and(eq(this.t.vgitRefs.repo, this.repoKey), eq(this.t.vgitRefs.name, name)))
    return row?.sha ?? null
  }

  /** compare-and-swap so two instances can't silently overwrite each other's commit */
  private async moveRef(name: string, from: string | null, to: string): Promise<void> {
    if (from === null) {
      await this.db.insert(this.t.vgitRefs).values({ repo: this.repoKey, name, sha: to })
      return
    }
    const updated = await this.db
      .update(this.t.vgitRefs)
      .set({ sha: to })
      .where(and(eq(this.t.vgitRefs.repo, this.repoKey), eq(this.t.vgitRefs.name, name), eq(this.t.vgitRefs.sha, from)))
      .returning({ sha: this.t.vgitRefs.sha })
    if (updated.length === 0) throw new Error(`branch ${name} moved underneath this commit — retry`)
  }

  private async resolve(ref: string, cwd?: string): Promise<string> {
    if (ref.endsWith('^')) {
      const c = await this.getCommit(await this.resolve(ref.slice(0, -1), cwd))
      if (!c?.parents[0]) throw new Error(`${ref} has no parent`)
      return c.parents[0]
    }
    if (ref === 'HEAD') {
      const branch = cwd && path.resolve(cwd) !== path.resolve(this.repoPath) ? await this.branchOf(cwd) : 'main'
      const sha = await this.refSha(branch)
      if (!sha) throw new Error(`unknown branch ${branch}`)
      return sha
    }
    const sha = await this.refSha(ref)
    if (sha) return sha
    if (/^[0-9a-f]{40}$/.test(ref) && (await this.getCommit(ref))) return ref
    throw new Error(`unknown revision ${ref}`)
  }

  private async branchOf(worktree: string): Promise<string> {
    if (path.resolve(worktree) === path.resolve(this.repoPath)) return 'main'
    const [row] = await this.db.select().from(this.t.vgitWorktrees).where(eq(this.t.vgitWorktrees.path, this.key(worktree)))
    if (!row) throw new Error(`not a checkout: ${worktree}`)
    return row.branch
  }

  // ------------------------------------------------------- working files
  /** the files on disk under dir, as path → content (text; binary is base64-tagged) */
  private readDir(dir: string): Map<string, string> {
    const out = new Map<string, string>()
    const walk = (abs: string, rel: string) => {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue
        const a = path.join(abs, e.name)
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(a, r)
        else if (e.isFile()) {
          const buf = fs.readFileSync(a)
          if (buf.length > MAX_FILE_BYTES) continue
          out.set(r, encode(buf))
        }
      }
    }
    walk(dir, '')
    return out
  }

  private async treeContents(tree: Tree): Promise<Map<string, string>> {
    const blobs = await this.getBlobs(Object.values(tree))
    const out = new Map<string, string>()
    for (const [p, h] of Object.entries(tree)) out.set(p, blobs.get(h) ?? '')
    return out
  }

  private async materialize(dir: string, sha: string): Promise<void> {
    const commit = await this.getCommit(sha)
    if (!commit) throw new Error(`missing commit ${sha}`)
    const files = await this.treeContents(commit.tree)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const [p, content] of files) {
      const abs = path.join(dir, p)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, decode(content))
    }
    materialized.set(path.resolve(dir), sha)
  }

  /**
   * Make sure `dir` holds its branch's latest commit. A no-op when this
   * instance already materialized that commit (so it never clobbers files a
   * running turn is editing here); a fresh instance rebuilds from the DB.
   */
  async ensureCheckout(dir: string): Promise<void> {
    const abs = path.resolve(dir)
    const sha = await this.resolve('HEAD', abs)
    if (materialized.get(abs) === sha && fs.existsSync(abs)) return
    await this.materialize(abs, sha)
  }

  // ------------------------------------------------- GitService surface
  static async initRepo(repoPath: string, readme: string, author: GitAuthor, deps: DbRepoDeps): Promise<DbRepo> {
    const repo = new DbRepo(repoPath, deps)
    const content = readme
    const hash = blobHash(content)
    await repo.putBlobs(new Map([[hash, content]]))
    const sha = await repo.writeCommit({ 'README.md': hash }, [], 'Initial commit', author)
    await repo.moveRef('main', null, sha)
    await repo.materialize(repoPath, sha)
    return repo
  }

  async currentSha(ref = 'HEAD', cwd?: string): Promise<string> {
    return this.resolve(ref, cwd)
  }

  async branchExists(name: string): Promise<boolean> {
    return (await this.refSha(name)) !== null
  }

  async createWorktree(worktreePath: string, branchName: string, startPoint: string): Promise<void> {
    const start = await this.resolve(startPoint)
    await this.moveRef(branchName, null, start)
    await this.db.insert(this.t.vgitWorktrees).values({ path: this.key(worktreePath), repo: this.repoKey, branch: branchName }).onConflictDoUpdate({
      target: this.t.vgitWorktrees.path,
      set: { repo: this.repoKey, branch: branchName },
    })
    await this.materialize(worktreePath, start)
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    fs.rmSync(worktreePath, { recursive: true, force: true })
    materialized.delete(path.resolve(worktreePath))
  }

  private async workingChanges(cwd: string): Promise<{ head: CommitRow; files: Map<string, string>; headFiles: Map<string, string> }> {
    const headSha = await this.resolve('HEAD', cwd)
    const head = (await this.getCommit(headSha))!
    return { head, files: this.readDir(cwd), headFiles: await this.treeContents(head.tree) }
  }

  async isDirty(cwd: string): Promise<boolean> {
    const { files, headFiles } = await this.workingChanges(cwd)
    if (files.size !== headFiles.size) return true
    for (const [p, c] of files) if (headFiles.get(p) !== c) return true
    return false
  }

  /** nothing to stage: the working directory IS the index here */
  async stageAll(_cwd: string): Promise<void> {}

  async stagedDiffs(cwd: string): Promise<FileDiff[]> {
    const { files, headFiles } = await this.workingChanges(cwd)
    return diffMaps(headFiles, files)
  }

  async commit(cwd: string, message: string, author: GitAuthor): Promise<string> {
    const branch = await this.branchOf(cwd)
    const parent = await this.resolve(branch)
    const files = this.readDir(cwd)
    const tree: Tree = {}
    const blobs = new Map<string, string>()
    for (const [p, c] of files) {
      const h = blobHash(c)
      tree[p] = h
      blobs.set(h, c)
    }
    await this.putBlobs(blobs)
    const sha = await this.writeCommit(tree, [parent], message, author)
    await this.moveRef(branch, parent, sha)
    materialized.set(path.resolve(cwd), sha)
    return sha
  }

  async log(ref: string, limit = 50): Promise<CommitInfo[]> {
    const out: CommitInfo[] = []
    let sha: string | null = await this.resolve(ref)
    while (sha && out.length < limit) {
      const c = await this.getCommit(sha)
      if (!c) break
      out.push({ sha: c.sha, subject: c.message.split('\n')[0] ?? '', authorName: c.authorName, date: c.createdAt })
      sha = c.parents[0] ?? null
    }
    return out
  }

  private ancestors(all: Map<string, CommitRow>, start: string): Set<string> {
    const seen = new Set<string>()
    const stack = [start]
    while (stack.length) {
      const s = stack.pop()!
      if (seen.has(s)) continue
      seen.add(s)
      for (const p of all.get(s)?.parents ?? []) stack.push(p)
    }
    return seen
  }

  async aheadBehind(branch: string, base = 'main'): Promise<{ ahead: number; behind: number }> {
    const all = await this.allCommits()
    const a = this.ancestors(all, await this.resolve(branch))
    const b = this.ancestors(all, await this.resolve(base))
    let ahead = 0
    let behind = 0
    for (const s of a) if (!b.has(s)) ahead++
    for (const s of b) if (!a.has(s)) behind++
    return { ahead, behind }
  }

  async listSessionBranches(): Promise<string[]> {
    const rows = await this.db.select().from(this.t.vgitRefs).where(eq(this.t.vgitRefs.repo, this.repoKey))
    return rows.map((r) => r.name).filter((n) => n !== 'main').sort()
  }

  async showFile(ref: string, filePath: string): Promise<string> {
    const c = await this.getCommit(await this.resolve(ref))
    const h = c?.tree[filePath]
    if (!h) throw new Error(`path ${filePath} does not exist in ${ref}`)
    return decode(((await this.getBlobs([h])).get(h) ?? '')).toString('utf8')
  }

  async listFilesAtRef(ref: string): Promise<string[]> {
    const c = await this.getCommit(await this.resolve(ref))
    return Object.keys(c?.tree ?? {}).sort()
  }

  private async commitDiffs(sha: string): Promise<FileDiff[]> {
    const c = await this.getCommit(sha)
    if (!c) return []
    const parent = c.parents[0] ? await this.getCommit(c.parents[0]) : null
    return diffMaps(parent ? await this.treeContents(parent.tree) : new Map(), await this.treeContents(c.tree))
  }

  async diffForCommit(sha: string): Promise<string> {
    return truncate((await this.commitDiffs(sha)).map((d) => d.unifiedDiff).join('\n'), 200_000)
  }

  async commitStats(sha: string): Promise<FileStat[]> {
    return (await this.commitDiffs(sha)).map(({ unifiedDiff: _u, ...s }) => s)
  }

  async readTree(ref: string): Promise<Map<string, string>> {
    const c = await this.getCommit(await this.resolve(ref))
    return c ? this.treeContents(c.tree) : new Map()
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    return this.mergeBaseOf(await this.allCommits(), await this.resolve(a), await this.resolve(b))
  }

  /** merge base: the nearest commit reachable from both (BFS from `a`, first hit in b's ancestry) */
  private mergeBaseOf(all: Map<string, CommitRow>, a: string, b: string): string | null {
    const inB = this.ancestors(all, b)
    const queue = [a]
    const seen = new Set<string>()
    while (queue.length) {
      const s = queue.shift()!
      if (seen.has(s)) continue
      seen.add(s)
      if (inB.has(s)) return s
      for (const p of all.get(s)?.parents ?? []) queue.push(p)
    }
    return null
  }

  async mergeIntoMain(branch: string, message: string, author: GitAuthor): Promise<{ ok: boolean; sha: string | null; conflicts: string[] }> {
    const all = await this.allCommits()
    const mainSha = await this.resolve('main')
    const branchSha = await this.resolve(branch)
    // already contained, or a fast-forward-able ancestor relationship
    if (this.ancestors(all, mainSha).has(branchSha)) return { ok: true, sha: mainSha, conflicts: [] }
    const baseSha = this.mergeBaseOf(all, mainSha, branchSha)
    const [ours, theirs, base] = await Promise.all([
      this.treeContents(all.get(mainSha)!.tree),
      this.treeContents(all.get(branchSha)!.tree),
      baseSha ? this.treeContents(all.get(baseSha)!.tree) : Promise.resolve(new Map<string, string>()),
    ])
    const merged = new Map<string, string>()
    const conflicts = new Map<string, string>()
    const paths = new Set([...ours.keys(), ...theirs.keys(), ...base.keys()])
    for (const p of paths) {
      const o = ours.get(p)
      const t = theirs.get(p)
      const b = base.get(p)
      if (o === t) {
        if (o !== undefined) merged.set(p, o)
      } else if (o === b) {
        if (t !== undefined) merged.set(p, t)
      } else if (t === b) {
        if (o !== undefined) merged.set(p, o)
      } else if (o !== undefined && t !== undefined && isText(o) && isText(t) && (b === undefined || isText(b))) {
        const r = diff3Merge(o.split('\n'), (b ?? '').split('\n'), t.split('\n'), { stringSeparator: '\n' })
        if (r.conflict) {
          const marked = r.result.join('\n').replace(/^<{7}$/gm, '<<<<<<< main').replace(/^>{7}$/gm, `>>>>>>> ${branch}`)
          conflicts.set(p, marked)
          merged.set(p, marked)
        } else merged.set(p, r.result.join('\n'))
      } else {
        // delete-vs-edit or binary: a conflict; the file as-is on the incoming side
        conflicts.set(p, t ?? o ?? '')
        if (t !== undefined || o !== undefined) merged.set(p, t ?? o!)
      }
    }
    const tree: Tree = {}
    const blobs = new Map<string, string>()
    for (const [p, c] of merged) {
      const h = blobHash(c)
      tree[p] = h
      blobs.set(h, c)
    }
    await this.putBlobs(blobs)
    if (conflicts.size > 0) {
      this.pendingMerge = { branch, tree, conflicts, mainSha, branchSha }
      return { ok: false, sha: null, conflicts: [...conflicts.keys()] }
    }
    const sha = await this.writeCommit(tree, [mainSha, branchSha], message, author)
    await this.moveRef('main', mainSha, sha)
    await this.materialize(this.repoPath, sha)
    return { ok: true, sha, conflicts: [] }
  }

  async abortMerge(): Promise<void> {
    this.pendingMerge = null
  }

  async resolveConflictsTheirs(conflictPaths: string[]): Promise<void> {
    const pm = this.pendingMerge
    if (!pm) return
    const theirs = await this.treeContents((await this.getCommit(pm.branchSha))!.tree)
    for (const p of conflictPaths) {
      const c = theirs.get(p)
      if (c === undefined) delete pm.tree[p]
      else {
        const h = blobHash(c)
        await this.putBlobs(new Map([[h, c]]))
        pm.tree[p] = h
      }
      pm.conflicts.delete(p)
    }
  }

  async readConflictedFile(filePath: string): Promise<string> {
    const c = this.pendingMerge?.conflicts.get(filePath)
    return c === undefined ? '' : decode(c).toString('utf8')
  }

  async writeResolvedFile(filePath: string, content: string): Promise<void> {
    const pm = this.pendingMerge
    if (!pm) return
    const h = blobHash(content)
    await this.putBlobs(new Map([[h, content]]))
    pm.tree[filePath] = h
    pm.conflicts.delete(filePath)
  }

  async commitMerge(message: string, author: GitAuthor): Promise<string> {
    const pm = this.pendingMerge
    if (!pm) throw new Error('no merge in progress')
    const sha = await this.writeCommit(pm.tree, [pm.mainSha, pm.branchSha], message, author)
    await this.moveRef('main', pm.mainSha, sha)
    this.pendingMerge = null
    await this.materialize(this.repoPath, sha)
    return sha
  }
}

// --------------------------------------------------------------- helpers
const B64 = '\u0000b64:'

function encode(buf: Buffer): string {
  const text = buf.toString('utf8')
  // round-trips cleanly → store as text; otherwise tag as base64
  return Buffer.from(text, 'utf8').equals(buf) && !text.startsWith(B64) ? text : B64 + buf.toString('base64')
}

function decode(content: string): Buffer {
  return content.startsWith(B64) ? Buffer.from(content.slice(B64.length), 'base64') : Buffer.from(content, 'utf8')
}

function isText(content: string): boolean {
  return !content.startsWith(B64)
}

function blobHash(content: string): string {
  return crypto.createHash('sha1').update(content).digest('hex')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '\n… (diff truncated)'
}

/** git-style per-file diffs between two path→content maps */
export function diffMaps(before: Map<string, string>, after: Map<string, string>): FileDiff[] {
  const out: FileDiff[] = []
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const p of paths) {
    const a = before.get(p)
    const b = after.get(p)
    if (a === b) continue
    const changeKind: FileDiff['changeKind'] = a === undefined ? 'create' : b === undefined ? 'delete' : 'edit'
    if ((a !== undefined && !isText(a)) || (b !== undefined && !isText(b))) {
      out.push({ path: p, changeKind, additions: 0, deletions: 0, unifiedDiff: `diff --git a/${p} b/${p}\nBinary files differ\n` })
      continue
    }
    const patch = structuredPatch(`a/${p}`, `b/${p}`, a ?? '', b ?? '', '', '', { context: 3 })
    let additions = 0
    let deletions = 0
    const lines = [
      `diff --git a/${p} b/${p}`,
      changeKind === 'create' ? 'new file mode 100644' : changeKind === 'delete' ? 'deleted file mode 100644' : null,
      `--- ${a === undefined ? '/dev/null' : `a/${p}`}`,
      `+++ ${b === undefined ? '/dev/null' : `b/${p}`}`,
    ].filter((l): l is string => l !== null)
    for (const h of patch.hunks) {
      lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
      for (const l of h.lines) {
        if (l.startsWith('+')) additions++
        else if (l.startsWith('-')) deletions++
        lines.push(l)
      }
    }
    out.push({ path: p, changeKind, additions, deletions, unifiedDiff: truncate(lines.join('\n') + '\n', 50_000) })
  }
  return out
}
