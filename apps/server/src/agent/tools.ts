import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import type { AgentToolExecution } from '@loom/shared'

const MAX_COMMAND_OUTPUT = 10_000 // 10KB
const COMMAND_TIMEOUT_MS = 30_000
const ALLOWED_COMMANDS = new Set(['node', 'npm', 'npx', 'pnpm', 'ls', 'cat'])
const MAX_FILE_BYTES = 512 * 1024

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
        const full = path.join(dir, entry.name)
        const rel = path.relative(this.root, full)
        if (entry.isDirectory()) {
          walk(full)
        } else {
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
    const lines = content.split('\n').length
    return { summary: `Read ${rel(this.root, p)} (${lines} lines)`, ok: true, content }
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
    if (!fs.existsSync(p)) throw new ToolError(`file not found: ${rel(this.root, p)}`)
    const current = await fsp.readFile(p, 'utf8')
    if (!current.includes(oldString)) {
      throw new ToolError(`old_string not found in ${rel(this.root, p)} — read the file first`)
    }
    const next = current.replace(oldString, newString)
    await fsp.writeFile(p, next)
    return { summary: `Edited ${rel(this.root, p)}`, ok: true, content: 'ok, replacement applied' }
  }

  private async deleteFile(input: Record<string, unknown>): Promise<AgentToolExecution> {
    const p = this.resolveSafe(input.path)
    if (!fs.existsSync(p)) throw new ToolError(`file not found: ${rel(this.root, p)}`)
    await fsp.rm(p)
    return { summary: `Deleted ${rel(this.root, p)}`, ok: true, content: 'ok, deleted' }
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
    description: 'Read a file from the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'relative path' } },
      required: ['path'],
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
    description: 'Replace the first occurrence of old_string with new_string in a file. old_string must match exactly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
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
