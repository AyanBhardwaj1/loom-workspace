import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_TOOL_NAMES } from '@loom/shared'
import { AGENT_TOOL_DEFS, ToolExecutor } from '../src/agent/tools'

let root: string
let tools: ToolExecutor

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tools-v2-'))
  tools = new ToolExecutor(root)
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content)
}
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')

describe('edit_file — ambiguous matches are refused, not guessed', () => {
  it('refuses an old_string that matches more than once (regression: it silently edited the first)', async () => {
    write('a.css', '.btn { color: red; }\n.link { color: red; }\n')
    const res = await tools.execute('edit_file', { path: 'a.css', old_string: 'color: red;', new_string: 'color: blue;' })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/2 places/)
    // nothing was written
    expect(read('a.css')).toBe('.btn { color: red; }\n.link { color: red; }\n')
  })

  it('replace_all edits every occurrence and reports the count', async () => {
    write('a.css', '.btn { color: red; }\n.link { color: red; }\n')
    const res = await tools.execute('edit_file', { path: 'a.css', old_string: 'red', new_string: 'blue', replace_all: true })
    expect(res.ok).toBe(true)
    expect(res.summary).toMatch(/2 replacements/)
    expect(read('a.css')).toBe('.btn { color: blue; }\n.link { color: blue; }\n')
  })

  it('a unique match still edits exactly once', async () => {
    write('a.css', '.btn { color: red; }\n.link { color: green; }\n')
    const res = await tools.execute('edit_file', { path: 'a.css', old_string: 'color: red;', new_string: 'color: blue;' })
    expect(res.ok).toBe(true)
    expect(read('a.css')).toBe('.btn { color: blue; }\n.link { color: green; }\n')
  })

  it('treats $ in new_string literally (String.replace would expand $& / $1)', async () => {
    write('price.js', 'const label = PRICE\n')
    const res = await tools.execute('edit_file', { path: 'price.js', old_string: 'PRICE', new_string: "'$&9.99'" })
    expect(res.ok).toBe(true)
    expect(read('price.js')).toBe("const label = '$&9.99'\n")
  })

  it('rejects an empty old_string instead of inserting at position 0', async () => {
    write('a.txt', 'hello')
    const res = await tools.execute('edit_file', { path: 'a.txt', old_string: '', new_string: 'x' })
    expect(res.ok).toBe(false)
    expect(read('a.txt')).toBe('hello')
  })
})

describe('read_file — paging for large files', () => {
  it('returns raw content unchanged by default', async () => {
    write('index.html', '<h1>hi</h1>\n<p>there</p>\n')
    const res = await tools.execute('read_file', { path: 'index.html' })
    expect(res.content).toBe('<h1>hi</h1>\n<p>there</p>\n')
  })

  it('offset + limit return a window and say where it sits', async () => {
    write('long.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'))
    const res = await tools.execute('read_file', { path: 'long.txt', offset: 10, limit: 3 })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('line 10\nline 11\nline 12')
    expect(res.content).not.toContain('line 13')
    expect(res.content).toMatch(/lines 10–12 of 50/)
  })

  it('caps an unpaged read of a huge file so one call cannot flood the context', async () => {
    write('huge.txt', Array.from({ length: 5_000 }, (_, i) => `row ${i + 1}`).join('\n'))
    const res = await tools.execute('read_file', { path: 'huge.txt' })
    expect(res.content).toContain('row 2000')
    expect(res.content).not.toContain('row 2001\n')
    expect(res.content).toMatch(/use offset/i)
  })
})

describe('search_files — find code without reading every file', () => {
  it('finds substring matches case-insensitively with path:line', async () => {
    write('index.html', '<form id="waitlist">\n</form>\n')
    write('src/app.js', "const el = document.getElementById('Waitlist')\n")
    write('notes.md', 'nothing here\n')
    const res = await tools.execute('search_files', { pattern: 'waitlist' })
    expect(res.ok).toBe(true)
    expect(res.content).toContain('index.html:1:')
    expect(res.content).toContain('src/app.js:1:')
    expect(res.content).not.toContain('notes.md')
    expect(res.summary).toMatch(/2 matches in 2 files/)
  })

  it('supports regex and a path scope', async () => {
    write('src/a.js', 'function alpha() {}\n')
    write('lib/b.js', 'function beta() {}\n')
    const res = await tools.execute('search_files', { pattern: 'function \\w+\\(', regex: true, path: 'src' })
    expect(res.content).toContain('src/a.js:1:')
    expect(res.content).not.toContain('lib/b.js')
  })

  it('reports an invalid regex as a tool error, and skips binaries and .git', async () => {
    write('img.png', 'PNG\0\0binary waitlist')
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, '.git', 'config'), 'waitlist')
    const none = await tools.execute('search_files', { pattern: 'waitlist' })
    expect(none.ok).toBe(true)
    expect(none.summary).toMatch(/no matches/i)
    const bad = await tools.execute('search_files', { pattern: '([', regex: true })
    expect(bad.ok).toBe(false)
  })

  it('stays inside the workspace', async () => {
    const res = await tools.execute('search_files', { pattern: 'root', path: '../../etc' })
    expect(res.ok).toBe(false)
    expect(res.summary).toMatch(/escapes/)
  })
})

describe('tool contract', () => {
  it('every declared tool is executable and every name is exported', async () => {
    expect(AGENT_TOOL_DEFS.map((d) => d.name).sort()).toEqual([...AGENT_TOOL_NAMES].sort())
    for (const def of AGENT_TOOL_DEFS) {
      const res = await tools.execute(def.name, {})
      expect(res.summary, def.name).not.toMatch(/Unknown tool/)
    }
  })
})
