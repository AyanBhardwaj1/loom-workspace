import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'

/**
 * The shared smoke test: what everyone in the session sees run, live, after
 * each commit or on demand. Static checks only read files; the package's own
 * test script runs only when asked for (it executes agent-written code — the
 * same exposure as the agent's allowlisted `npm` command, with the same
 * minimal environment).
 */
export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface CheckResult {
  id: string
  label: string
  status: CheckStatus
  detail?: string
}

export interface CheckRun {
  status: 'passed' | 'warned' | 'failed'
  results: CheckResult[]
  durationMs: number
}

const MAX_FILES = 400
const MAX_FILE_BYTES = 512 * 1024
const TEST_TIMEOUT_MS = 30_000
const NPM_DEFAULT_TEST = /no test specified/

export async function runChecks(root: string, opts: { runTests?: boolean } = { runTests: true }): Promise<CheckRun> {
  const started = Date.now()
  const files = listFiles(root)
  const html = files.filter((f) => /\.html?$/i.test(f))
  const results: CheckResult[] = []

  const entry = html.includes('index.html')
  results.push(
    entry
      ? { id: 'entry', label: 'Entry page', status: 'pass', detail: 'index.html' }
      : { id: 'entry', label: 'Entry page', status: 'fail', detail: 'No index.html — the preview has nothing to open.' },
  )

  if (html.length > 0) {
    results.push(checkLinks(root, html))
    results.push(checkHtmlBasics(root, html))
    results.push(checkImgAlt(root, html))
    results.push(checkFormLabels(root, html))
  }
  // AI-built apps ship keys in the client more than anything else — fail loudly
  results.push(checkSecrets(root, files))
  const css = files.filter((f) => f.endsWith('.css'))
  if (css.length > 0) results.push(checkCss(root, css))
  const js = files.filter((f) => /\.(m?js)$/.test(f))
  if (js.length > 0) results.push(await checkJsSyntax(root, js))
  if (opts.runTests !== false) {
    const tests = await runPackageTests(root)
    if (tests) results.push(tests)
  }

  const status = results.some((r) => r.status === 'fail') ? 'failed' : results.some((r) => r.status === 'warn') ? 'warned' : 'passed'
  return { status, results, durationMs: Date.now() - started }
}

/** One line for transcripts and the agent: "3 of 6 checks need attention: …". */
export function summarizeChecks(run: CheckRun): string {
  const bad = run.results.filter((r) => r.status !== 'pass')
  if (bad.length === 0) return `All ${run.results.length} checks passed.`
  return `${bad.length} of ${run.results.length} checks need attention: ${bad
    .map((r) => `${r.label} (${r.status}${r.detail ? `: ${r.detail.slice(0, 160)}` : ''})`)
    .join('; ')}`
}

function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.isSymbolicLink()) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) out.push(path.relative(root, full))
      if (out.length >= MAX_FILES) return
    }
  }
  walk(root)
  return out
}

function read(root: string, rel: string): string {
  const full = path.join(root, rel)
  try {
    if (fs.statSync(full).size > MAX_FILE_BYTES) return ''
    return fs.readFileSync(full, 'utf8')
  } catch {
    return ''
  }
}

/** Every local href/src in every page must resolve to a file in the workspace. */
function checkLinks(root: string, pages: string[]): CheckResult {
  const broken = new Set<string>()
  for (const page of pages) {
    const src = read(root, page)
    for (const m of src.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) {
      const ref = m[1]!.trim()
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{)/i.test(ref)) continue // external, data:, mailto:, anchors, templates
      const clean = ref.split(/[?#]/)[0]!
      if (!clean) continue
      const target = path.normalize(path.join(clean.startsWith('/') ? '' : path.dirname(page), clean.replace(/^\/+/, '')))
      if (target.startsWith('..')) {
        broken.add(`${page} → ${ref}`)
        continue
      }
      const full = path.join(root, target)
      const ok = fs.existsSync(full) && (fs.statSync(full).isFile() || fs.existsSync(path.join(full, 'index.html')))
      if (!ok) broken.add(`${page} → ${ref}`)
    }
  }
  return broken.size === 0
    ? { id: 'links', label: 'Links & assets', status: 'pass' }
    : { id: 'links', label: 'Links & assets', status: 'fail', detail: [...broken].slice(0, 12).join(', ') }
}

function checkHtmlBasics(root: string, pages: string[]): CheckResult {
  const missing: string[] = []
  for (const page of pages) {
    const src = read(root, page)
    const gaps = [
      !/<!doctype html>/i.test(src) && 'doctype',
      !/<html[^>]*\blang\s*=/i.test(src) && 'lang',
      !/<title>[^<]+<\/title>/i.test(src) && 'title',
      !/<meta[^>]+name\s*=\s*["']viewport["']/i.test(src) && 'viewport',
    ].filter(Boolean)
    if (gaps.length > 0) missing.push(`${page}: no ${gaps.join(', ')}`)
  }
  return missing.length === 0
    ? { id: 'html-basics', label: 'Page basics', status: 'pass' }
    : { id: 'html-basics', label: 'Page basics', status: 'warn', detail: missing.slice(0, 8).join('; ') }
}

function checkImgAlt(root: string, pages: string[]): CheckResult {
  let missing = 0
  for (const page of pages) {
    for (const m of read(root, page).matchAll(/<img\b[^>]*>/gi)) {
      if (!/\balt\s*=/i.test(m[0])) missing++
    }
  }
  return missing === 0
    ? { id: 'img-alt', label: 'Image alt text', status: 'pass' }
    : { id: 'img-alt', label: 'Image alt text', status: 'warn', detail: `${missing} image${missing === 1 ? '' : 's'} without alt text` }
}

/** Brace balance, ignoring comments and strings — catches the classic truncated rule. */
/**
 * Credentials in shipped files. Everything in the workspace is served by the
 * preview (and would be by any static host), so a key here is a key in public.
 * Patterns cover the common providers; a match names the file, never the value.
 */
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'Anthropic key', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Stripe secret key', re: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Supabase service-role key', re: /service_role["'\s:=]+["']?eyJ[A-Za-z0-9_-]{20,}/i },
]

function checkSecrets(root: string, files: string[]): CheckResult {
  const found: string[] = []
  for (const f of files) {
    const base = f.split('/').pop() ?? f
    if (base === '.env' || /^\.env\.(?!example$|sample$)/.test(base)) {
      found.push(`${f} (environment file)`)
      continue
    }
    if (!/\.(html?|m?js|ts|tsx|jsx|json|css|md|txt|ya?ml|toml|env)$/i.test(f)) continue
    const text = read(root, f)
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) {
        found.push(`${f} (${p.name})`)
        break
      }
    }
  }
  return found.length === 0
    ? { id: 'secrets', label: 'No exposed secrets', status: 'pass' }
    : { id: 'secrets', label: 'No exposed secrets', status: 'fail', detail: `Credentials would ship to every visitor: ${found.slice(0, 5).join(', ')}` }
}

/** form controls a screen reader can name: a <label for>, a wrapping <label>, or aria-label(ledby) */
function checkFormLabels(root: string, pages: string[]): CheckResult {
  let unlabeled = 0
  for (const page of pages) {
    const html = read(root, page)
    const labelled = new Set([...html.matchAll(/<label[^>]*\bfor=["']([^"']+)["']/gi)].map((m) => m[1]))
    // strip <label>…</label> blocks: controls inside them are labelled by wrapping
    const outside = html.replace(/<label\b[\s\S]*?<\/label>/gi, '')
    for (const m of outside.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const attrs = m[2] ?? ''
      if (/\btype=["']?(hidden|submit|button|reset|image)\b/i.test(attrs)) continue
      if (/\baria-label(ledby)?=/i.test(attrs)) continue
      const id = /\bid=["']([^"']+)["']/i.exec(attrs)?.[1]
      if (id && labelled.has(id)) continue
      unlabeled++
    }
  }
  return unlabeled === 0
    ? { id: 'form-labels', label: 'Form fields have labels', status: 'pass' }
    : { id: 'form-labels', label: 'Form fields have labels', status: 'warn', detail: `${unlabeled} field${unlabeled === 1 ? '' : 's'} a screen reader can't name (placeholder isn't a label)` }
}

function checkCss(root: string, sheets: string[]): CheckResult {
  const bad: string[] = []
  for (const sheet of sheets) {
    const src = read(root, sheet)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
    let depth = 0
    let negative = false
    for (const ch of src) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
      if (depth < 0) negative = true
    }
    if (depth !== 0 || negative) bad.push(sheet)
  }
  return bad.length === 0
    ? { id: 'css', label: 'Stylesheets', status: 'pass' }
    : { id: 'css', label: 'Stylesheets', status: 'fail', detail: `Unbalanced braces in ${bad.join(', ')}` }
}

/** `node --check` per file; ES-module syntax is checked as .mjs. */
async function checkJsSyntax(root: string, scripts: string[]): Promise<CheckResult> {
  const errors: string[] = []
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-jscheck-'))
  try {
    for (const rel of scripts.slice(0, 60)) {
      const src = read(root, rel)
      const isModule = rel.endsWith('.mjs') || /^\s*(?:import\s[\s\S]*?from\s|import\s*['"]|export\s)/m.test(src)
      const target = path.join(tmp, `${errors.length}-${path.basename(rel).replace(/\.m?js$/, '')}${isModule ? '.mjs' : '.cjs'}`)
      fs.writeFileSync(target, src)
      const res = await execa(process.execPath, ['--check', target], {
        reject: false,
        timeout: 10_000,
        extendEnv: false,
        env: { PATH: process.env.PATH ?? '' },
      })
      if (res.exitCode !== 0) {
        const msg = String(res.stderr).split('\n').find((l) => /Error/.test(l)) ?? 'syntax error'
        errors.push(`${rel}: ${msg.trim()}`)
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return errors.length === 0
    ? { id: 'js-syntax', label: 'JavaScript', status: 'pass' }
    : { id: 'js-syntax', label: 'JavaScript', status: 'fail', detail: errors.slice(0, 6).join('; ') }
}

async function runPackageTests(root: string): Promise<CheckResult | null> {
  const pkgPath = path.join(root, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  let script: unknown
  try {
    script = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }).scripts?.test
  } catch {
    return { id: 'tests', label: 'Test script', status: 'fail', detail: 'package.json is not valid JSON' }
  }
  if (typeof script !== 'string' || NPM_DEFAULT_TEST.test(script)) return null
  const res = await execa('npm', ['test', '--silent'], {
    cwd: root,
    reject: false,
    all: true,
    timeout: TEST_TIMEOUT_MS,
    // same isolation as the agent's run_command: no server secrets in the child env
    extendEnv: false,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, NO_COLOR: '1', CI: '1' },
  })
  const out = String(res.all ?? '').trim()
  const tail = out.split('\n').slice(-12).join('\n')
  if (res.timedOut) return { id: 'tests', label: 'Test script', status: 'fail', detail: `Timed out after ${TEST_TIMEOUT_MS / 1000}s` }
  return res.exitCode === 0
    ? { id: 'tests', label: 'Test script', status: 'pass', detail: tail.slice(0, 600) || undefined }
    : { id: 'tests', label: 'Test script', status: 'fail', detail: tail.slice(0, 600) || `exited with ${res.exitCode}` }
}
