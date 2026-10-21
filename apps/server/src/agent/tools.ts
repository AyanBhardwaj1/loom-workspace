import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { execa } from 'execa'
import type { AgentToolExecution } from '@loom/shared'

const MAX_COMMAND_OUTPUT = 10_000 // 10KB
const COMMAND_TIMEOUT_MS = 30_000
const ALLOWED_COMMANDS = new Set(['node', 'npm', 'npx', 'pnpm', 'ls', 'cat'])
const MAX_FILE_BYTES = 512 * 1024
/** an unpaged read returns at most this many lines — large files are read in windows */
const MAX_READ_LINES = 2000
const MAX_SEARCH_MATCHES = 100
const MAX_SEARCH_LINE_CHARS = 200
/** a backtracking regex must never hold the server's event loop hostage */
const SEARCH_DEADLINE_MS = 2_000

/**
 * The search loop, run in a throwaway worker thread: JS regexes backtrack,
 * and a catastrophic pattern (model-chosen, possibly prompt-injected) would
 * otherwise freeze every session on the instance. The parent terminates the
 * worker at the deadline. Files arrive pre-vetted (inside the root, regular).
 */
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const fs = require('node:fs')
const path = require('node:path')
const { root, files, pattern, regex, maxFileBytes, maxMatches, maxLineChars } = workerData
const re = regex ? new RegExp(pattern, 'i') : null
const needle = pattern.toLowerCase()
const hits = []
const filesHit = []
for (const file of files) {
  if (hits.length >= maxMatches) break
  const full = path.join(root, file)
  let text
  try {
    const st = fs.lstatSync(full)
    if (!st.isFile() || st.size > maxFileBytes) continue
    text = fs.readFileSync(full, 'utf8')
  } catch { continue }
  if (text.includes('\\0')) continue
  const lines = text.split('\\n')
  let hit = false
  for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
    const line = lines[i].slice(0, 2000)
    if (!(re ? re.test(line) : line.toLowerCase().includes(needle))) continue
    const trimmed = line.trim()
    hits.push(file + ':' + (i + 1) + ': ' + (trimmed.length > maxLineChars ? trimmed.slice(0, maxLineChars) + '… (truncated)' : trimmed))
    hit = true
  }
  if (hit) filesHit.push(file)
}
parentPort.postMessage({ hits, filesHit: filesHit.length })
`

export class ToolError extends Error {}

/**
 * Executes agent tools against one session's worktree. Sandboxing is a hard
 * requirement: every path is resolved and verified to stay inside the
 * worktree, `.git` is off-limits, and run_command is allowlisted with a
 * timeout and truncated output.
 */
export class ToolExecutor {
  private root: string

  constructor(worktreePath: string) {
    this.root = path.resolve(worktreePath)
  }

  /** Resolve a user/model-supplied path and reject anything escaping the worktree. */
  resolveSafe(p: unknown): string {
    if (typeof p !== 'string' || p.trim() === '') throw new ToolError('a relative "path" is required')
    const resolved = path.resolve(this.root, p)
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new ToolError(`path escapes the session workspace: ${p}`)
    }
    // case-insensitive: macOS/Windows filesystems would happily open ".GIT"
    const rel = path.relative(this.root, resolved).toLowerCase()
    if (rel === '.git' || rel.startsWith('.git' + path.sep)) {
      throw new ToolError('the .git directory is off-limits')
    }
    // if the file (or nearest existing ancestor) is a symlink pointing outside, reject
    let probe = resolved
    while (probe !== this.root) {
      if (fs.existsSync(probe)) {
        const real = fs.realpathSync(probe)
        const realRoot = fs.realpathSync(this.root)
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          throw new ToolError(`path escapes the session workspace via symlink: ${p}`)
        }
        break
      }
      probe = path.dirname(probe)
    }
    return resolved
  }

  async execute(name: string, input: Record<string, unknown>): Promise<AgentToolExecution> {
    try {
      switch (name) {
        case 'list_files':
          return await this.listFiles()
        case 'read_file':
          return await this.readFile(input)
        case 'write_file':
          return await this.writeFile(input)
        case 'edit_file':
          return await this.editFile(input)
        case 'delete_file':
          return await this.deleteFile(input)
        case 'search_files':
          return await this.searchFiles(input)
        case 'run_command':
          return await this.runCommand(input)
        default:
          return { summary: `Unknown tool: ${name}`, ok: false }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { summary: `${name} failed: ${truncate(message, 120)}`, ok: false, detail: truncate(message, 2000) }
    }
  }

  listTree(): string[] {
    const out: string[] = []
    const walk = (dir: string) => {
      if (out.length >= 500) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue
        // symlinks are never listed or followed: they are how content from
        // outside the worktree would sneak into reads and searches
        if (entry.isSymbolicLink()) continue
        const full = path.join(dir, entry.name)
        const rel = path.relative(this.root, full)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          out.push(rel)
        }
        if (out.length >= 500) return
      }
    }
    walk(this.root)
    return out
  }

  private async listFiles(): Promise<AgentToolExecution> {
    const files = this.listTree()
    const content = files.length > 0 ? files.join('\n') : '(the workspace is empty)'
    return { summary: `Listed ${files.length} file${files.length === 1 ? '' : 's'}`, ok: true, content }
  }

  private async readFile(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const p = this.resolveSafe(input.path)
    const stat = await fsp.stat(p)
    if (stat.size > MAX_FILE_BYTES) throw new ToolError('file too large to read')
    const content = await fsp.readFile(p, 'utf8')
    const lines = content.split('\n')
    const name = rel(this.root, p)
    const paged = input.offset !== undefined || input.limit !== undefined
    if (!paged && lines.length <= MAX_READ_LINES) {
      return { summary: `Read ${name} (${lines.length} lines)`, ok: true, content }
    }
    const start = Math.max(1, positiveInt(input.offset) ?? 1)
    if (start > lines.length) throw new ToolError(`offset ${start} is past the end of ${name} (${lines.length} lines)`)
    const count = Math.min(MAX_READ_LINES, positiveInt(input.limit) ?? MAX_READ_LINES)
    const end = Math.min(lines.length, start + count - 1)
    const window = lines.slice(start - 1, end).join('\n')
    const more = end < lines.length ? ` — use offset ${end + 1} to read on` : ''
    return {
      summary: `Read ${name} lines ${start}–${end} of ${lines.length}`,
      ok: true,
      content: `${window}\n\n(${name}: lines ${start}–${end} of ${lines.length}${more})`,
    }
  }

  private async writeFile(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const p = this.resolveSafe(input.path)
    const content = typeof input.content === 'string' ? input.content : null
    if (content === null) throw new ToolError('"content" (string) is required')
    if (content.length > MAX_FILE_BYTES) throw new ToolError('content too large')
    const existed = fs.existsSync(p)
    await fsp.mkdir(path.dirname(p), { recursive: true })
    await fsp.writeFile(p, content)
    const lines = content.split('\n').length
    return {
      summary: `${existed ? 'Rewrote' : 'Created'} ${rel(this.root, p)} (${lines} lines)`,
      ok: true,
      content: `ok, wrote ${lines} lines`,
    }
  }

  private async editFile(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const p = this.resolveSafe(input.path)
    const oldString = typeof input.old_string === 'string' ? input.old_string : null
    const newString = typeof input.new_string === 'string' ? input.new_string : null
    if (oldString === null || newString === null) throw new ToolError('"old_string" and "new_string" are required')
    if (oldString === '') throw new ToolError('"old_string" must not be empty — use write_file to create content')
    if (!fs.existsSync(p)) throw new ToolError(`file not found: ${rel(this.root, p)}`)
    const current = await fsp.readFile(p, 'utf8')
    const name = rel(this.root, p)
    // split/join, never String.replace: a replacement string expands $& / $1 / $$
    const parts = current.split(oldString)
    const matches = parts.length - 1
    if (matches === 0) throw new ToolError(`old_string not found in ${name} — read the file first`)
    if (matches > 1 && input.replace_all !== true) {
      throw new ToolError(
        `old_string matches ${matches} places in ${name} — include more surrounding lines to make it unique, or set replace_all`,
      )
    }
    await fsp.writeFile(p, parts.join(newString))
    return {
      summary: matches > 1 ? `Edited ${name} (${matches} replacements)` : `Edited ${name}`,
      ok: true,
      content: matches > 1 ? `ok, ${matches} replacements applied` : 'ok, replacement applied',
    }
  }

  private async deleteFile(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const p = this.resolveSafe(input.path)
    if (!fs.existsSync(p)) throw new ToolError(`file not found: ${rel(this.root, p)}`)
    await fsp.rm(p)
    return { summary: `Deleted ${rel(this.root, p)}`, ok: true, content: 'ok, deleted' }
  }

  /** grep for the agent: substring (default, case-insensitive) or regex, bounded output */
  private async searchFiles(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    if (!pattern) throw new ToolError('"pattern" (string) is required')
    const regex = input.regex === true
    if (regex) {
      try {
        new RegExp(pattern, 'i') // compiling is linear; only matching can explode
      } catch (err) {
        throw new ToolError(`invalid regex: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const scope = input.path === undefined || input.path === '' ? null : rel(this.root, this.resolveSafe(input.path))
    const files = this.listTree().filter((f) => scope === null || scope === '.' || f === scope || f.startsWith(scope + path.sep))
    const { hits, filesHit } = await runSearchWorker({
      root: this.root,
      files,
      pattern,
      regex,
      maxFileBytes: MAX_FILE_BYTES,
      maxMatches: MAX_SEARCH_MATCHES,
      maxLineChars: MAX_SEARCH_LINE_CHARS,
    })
    if (hits.length === 0) return { summary: `No matches for "${truncate(pattern, 40)}"`, ok: true, content: '(no matches)' }
    const capped = hits.length >= MAX_SEARCH_MATCHES ? `\n(stopped at ${MAX_SEARCH_MATCHES} matches — narrow the pattern or path)` : ''
    return {
      summary: `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${filesHit} file${filesHit === 1 ? '' : 's'}`,
      ok: true,
      content: hits.join('\n') + capped,
    }
  }

  private async runCommand(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    if (!command) throw new ToolError('"command" (string) is required')
    // no shell: naive whitespace split keeps this predictable and injection-free
    const argv = command.split(/\s+/)
    const bin = argv[0]!
    if (!ALLOWED_COMMANDS.has(bin)) {
      throw new ToolError(`command not allowed: ${bin} (allowed: ${[...ALLOWED_COMMANDS].join(', ')})`)
    }
    for (const arg of argv.slice(1)) {
      if (arg.includes('..')) throw new ToolError(`argument may not contain "..": ${arg}`)
      if (path.isAbsolute(arg)) throw new ToolError(`absolute paths are not allowed: ${arg}`)
    }
    const res = await execa(bin, argv.slice(1), {
      cwd: this.root,
      timeout: COMMAND_TIMEOUT_MS,
      all: true,
      reject: false,
      // extendEnv:false — the child must NOT inherit the server's environment
      // (ANTHROPIC_API_KEY, COOKIE_SECRET, DATABASE_URL…). `node` can read its
      // env and filesystem, so it gets a minimal env and the worktree as HOME.
      // True OS-level isolation (containers/jails) is the production answer;
      // this closes the secret-leak channel for the demo threat model.
      extendEnv: false,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: this.root, NO_COLOR: '1' },
    })
    const output = truncate(String(res.all ?? ''), MAX_COMMAND_OUTPUT)
    const ok = res.exitCode === 0
    return {
      summary: ok ? `Ran \`${truncate(command, 60)}\`` : `\`${truncate(command, 60)}\` exited with ${res.exitCode}`,
      ok,
      detail: output || undefined,
      content: output || '(no output)',
    }
  }
}

function runSearchWorker(data: Record<string, unknown>): Promise<{ hits: string[]; filesHit: number }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: data })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new ToolError(`search took too long (over ${SEARCH_DEADLINE_MS / 1000}s) — simplify the pattern or narrow the path`))
    }, SEARCH_DEADLINE_MS)
    worker.once('message', (msg: { hits: string[]; filesHit: number }) => {
      clearTimeout(timer)
      void worker.terminate()
      resolve(msg)
    })
    worker.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

function rel(root: string, p: string): string {
  return path.relative(root, p) || '.'
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '… (truncated)' : s
}

/** Anthropic tool-use schemas for the real provider. */
export const AGENT_TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'List every file in the project workspace (relative paths).',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description:
      'Read a file from the workspace. Files over 2000 lines are returned in windows: pass offset (1-based line) and limit to read further.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'relative path' },
        offset: { type: 'integer', description: 'first line to read (1-based)' },
        limit: { type: 'integer', description: 'number of lines to read (max 2000)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description:
      'Search file contents across the workspace. Case-insensitive substring by default; set regex for a regular expression. Returns up to 100 "path:line: text" matches.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'text or regex to find' },
        regex: { type: 'boolean', description: 'treat pattern as a regular expression' },
        path: { type: 'string', description: 'limit the search to this file or directory' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file with the given content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'relative path' },
        content: { type: 'string', description: 'full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Replace old_string with new_string in a file. old_string must match exactly ONE place (include surrounding lines to make it unique), unless replace_all is set.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: 'replace every occurrence' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a command in the workspace. Allowed binaries: node, npm, npx, pnpm, ls, cat. 30s timeout, output truncated to 10KB.',
    input_schema: {
      type: 'object' as const,
      properties: { command: { type: 'string', description: 'e.g. "node index.js"' } },
      required: ['command'],
    },
  },
]
