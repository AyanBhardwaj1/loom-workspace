import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runChecks, summarizeChecks } from '../src/checks/runChecks'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-checks-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), content)
}

const GOOD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Nimbus</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <img src="logo.svg" alt="Nimbus logo" />
  <label for="email">Email</label><input id="email" type="email" />
  <script src="app.js"></script>
</body>
</html>`

const byId = (results: Awaited<ReturnType<typeof runChecks>>['results'], id: string) => results.find((r) => r.id === id)

describe('runChecks — the shared smoke test of what the agent built', () => {
  it('a well-formed site passes every check', async () => {
    write('index.html', GOOD_HTML)
    write('styles.css', 'body { margin: 0; }\n')
    write('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    write('app.js', "document.querySelector('#email')\n")
    const run = await runChecks(root)
    expect(run.results.filter((r) => r.status !== 'pass')).toEqual([])
    expect(run.status).toBe('passed')
    expect(summarizeChecks(run)).toMatch(/all \d+ checks passed/i)
  })

  it('fails when there is no entry page', async () => {
    write('styles.css', 'body{}')
    const run = await runChecks(root)
    expect(byId(run.results, 'entry')!.status).toBe('fail')
    expect(run.status).toBe('failed')
  })

  it('catches broken local references, but ignores external, anchor and data URLs', async () => {
    write(
      'index.html',
      GOOD_HTML.replace('logo.svg', 'missing.png').replace(
        '</body>',
        '<a href="#top">top</a><a href="https://example.com">x</a><img src="data:image/png;base64,AA" alt="dot"/><a href="about.html">about</a></body>',
      ),
    )
    write('styles.css', 'body{}')
    write('app.js', 'void 0')
    const run = await runChecks(root)
    const links = byId(run.results, 'links')!
    expect(links.status).toBe('fail')
    expect(links.detail).toContain('missing.png')
    expect(links.detail).toContain('about.html')
    expect(links.detail).not.toContain('example.com')
  })

  it('reports JavaScript syntax errors with the file name, including ES modules', async () => {
    write('index.html', GOOD_HTML)
    write('styles.css', 'body{}')
    write('logo.svg', '<svg/>')
    write('app.js', 'function broken( {\n')
    write('mod.js', "import { x } from './x.js'\nexport const y = x\n")
    write('x.js', 'export const x = 1\n')
    const run = await runChecks(root)
    const js = byId(run.results, 'js-syntax')!
    expect(js.status).toBe('fail')
    expect(js.detail).toContain('app.js')
    expect(js.detail).not.toContain('mod.js')
  })

  it('warns (not fails) on accessibility basics: missing alt, title, lang, viewport', async () => {
    write('index.html', '<!doctype html><html><head></head><body><img src="a.svg"></body></html>')
    write('a.svg', '<svg/>')
    const run = await runChecks(root)
    expect(byId(run.results, 'html-basics')!.status).toBe('warn')
    expect(byId(run.results, 'img-alt')!.status).toBe('warn')
    expect(run.status).toBe('warned')
  })

  it('flags unbalanced CSS braces', async () => {
    write('index.html', GOOD_HTML)
    write('styles.css', '.a { color: red;\n.b { color: blue; }\n')
    write('logo.svg', '<svg/>')
    write('app.js', 'void 0')
    const run = await runChecks(root)
    expect(byId(run.results, 'css')!.status).toBe('fail')
  })

  it('runs the package test script only when one is defined', async () => {
    write('index.html', GOOD_HTML)
    write('styles.css', 'body{}')
    write('logo.svg', '<svg/>')
    write('app.js', 'void 0')
    let run = await runChecks(root)
    expect(byId(run.results, 'tests')).toBeUndefined()

    write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'node test.js' } }))
    write('test.js', "if (1 + 1 !== 2) { process.exit(1) }\nconsole.log('ok')\n")
    run = await runChecks(root)
    expect(byId(run.results, 'tests')!.status).toBe('pass')

    write('test.js', "console.error('expected 3, got 2'); process.exit(1)\n")
    run = await runChecks(root)
    const tests = byId(run.results, 'tests')!
    expect(tests.status).toBe('fail')
    expect(tests.detail).toContain('expected 3, got 2')
  }, 60_000)
})
