import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolExecutor } from '../src/agent/tools'

let root: string
let outside: string
let tools: ToolExecutor

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sandbox-'))
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outside-'))
  fs.mkdirSync(path.join(root, '.git'), { recursive: true })
  fs.writeFileSync(path.join(root, '.git', 'config'), '[core]')
  tools = new ToolExecutor(root)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

describe('sandbox', () => {
  it('rejects path traversal', async () => {
    const res = await tools.execute('read_file', { path: '../../../etc/passwd' })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/escapes/)
  })

  it('rejects absolute paths outside the worktree', async () => {
    const res = await tools.execute('write_file', { path: '/etc/loom-evil', content: 'x' })
    expect(res.ok).toBe(false)
  })

  it('allows an absolute path only if it resolves inside the worktree', async () => {
    const res = await tools.execute('write_file', { path: path.join(root, 'ok.txt'), content: 'fine' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8')).toBe('fine')
  })

  it('refuses to touch .git', async () => {
    const res = await tools.execute('write_file', { path: '.git/hooks/pre-commit', content: '#!/bin/sh' })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/off-limits/)
  })

  it('refuses symlink escapes', async () => {
    fs.symlinkSync(outside, path.join(root, 'link'))
    const res = await tools.execute('write_file', { path: 'link/evil.txt', content: 'x' })
    expect(res.ok).toBe(false)
    fs.unlinkSync(path.join(root, 'link'))
  })

  it('rejects disallowed commands and suspicious args', async () => {
    const rejected = await tools.execute('run_command', { command: 'rm -rf .' })
    expect(rejected.ok).toBe(false)
    expect(rejected.summary).toMatch(/not allowed/)

    const traversal = await tools.execute('run_command', { command: 'cat ../secret.txt' })
    expect(traversal.ok).toBe(false)

    const absolute = await tools.execute('run_command', { command: 'cat /etc/passwd' })
    expect(absolute.ok).toBe(false)
  })
})

describe('tool behaviors', () => {
  it('write / read / edit / delete round-trip', async () => {
    const w = await tools.execute('write_file', { path: 'notes/hello.txt', content: 'hello world\n' })
    expect(w.ok).toBe(true)

    const r = await tools.execute('read_file', { path: 'notes/hello.txt' })
    expect(r.ok).toBe(true)
    expect(r.content).toBe('hello world\n')

    const e = await tools.execute('edit_file', {
      path: 'notes/hello.txt',
      old_string: 'hello',
      new_string: 'goodbye',
    })
    expect(e.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'notes/hello.txt'), 'utf8')).toBe('goodbye world\n')

    const missing = await tools.execute('edit_file', {
      path: 'notes/hello.txt',
      old_string: 'not-present',
      new_string: 'x',
    })
    expect(missing.ok).toBe(false)

    const d = await tools.execute('delete_file', { path: 'notes/hello.txt' })
    expect(d.ok).toBe(true)
    expect(fs.existsSync(path.join(root, 'notes/hello.txt'))).toBe(false)
  })

  it('list_files skips .git and returns relative paths', async () => {
    await tools.execute('write_file', { path: 'a.txt', content: '1' })
    await tools.execute('write_file', { path: 'sub/b.txt', content: '2' })
    const res = await tools.execute('list_files', {})
    expect(res.ok).toBe(true)
    expect(res.content).toContain('a.txt')
    expect(res.content).toContain(path.join('sub', 'b.txt'))
    expect(res.content).not.toContain('.git')
  })

  it('run_command executes allowlisted binaries in the worktree', async () => {
    await tools.execute('write_file', { path: 'hi.js', content: 'console.log("from-node")' })
    const res = await tools.execute('run_command', { command: 'node hi.js' })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('from-node')
  })

  it('reports unknown tools without throwing', async () => {
    const res = await tools.execute('teleport', {})
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/Unknown tool/)
  })
})
