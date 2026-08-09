// Boots a fully self-contained Loom instance for the E2E run:
//   - a fresh temp data dir (so no real API key is ever picked up),
//   - MOCK agent mode (no ANTHROPIC_API_KEY / DATABASE_URL in the child env),
//   - seeded founders + the Nimbus demo project,
//   - the single server process serving the built web (apps/web/dist).
// Playwright's webServer waits for the port, then runs the specs against it.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../..')
const serverDir = path.join(repoRoot, 'apps/server')
const port = process.env.E2E_PORT ?? '4599'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-e2e-'))
const env = {
  ...process.env,
  NODE_ENV: 'test', // isDev → dev quick-login is available to the specs
  PORT: port,
  HOST: '127.0.0.1',
  LOOM_DATA_DIR: dataDir,
  LOOM_SQLITE_PATH: path.join(dataDir, 'e2e.db'),
  LOOM_FAST_MOCK: '1', // deterministic, no-delay mock turns for the E2E
}
// force mock mode — the E2E must never touch a real provider
delete env.ANTHROPIC_API_KEY
delete env.DATABASE_URL

// tsx is a dependency of @loom/server; pnpm keeps its bin in the package
const tsx = path.join(serverDir, 'node_modules/.bin/tsx')

console.log('[e2e] seeding temp instance at', dataDir)
const seed = spawnSync(tsx, ['src/seed.ts'], { cwd: serverDir, env, stdio: 'inherit' })
if (seed.status !== 0) {
  console.error('[e2e] seed failed')
  process.exit(1)
}

console.log('[e2e] starting server (mock mode) on', port)
const server = spawn(tsx, ['src/index.ts'], { cwd: serverDir, env, stdio: 'inherit' })

const cleanup = () => {
  try {
    server.kill('SIGTERM')
  } catch {
    // already gone
  }
  fs.rmSync(dataDir, { recursive: true, force: true })
}
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
server.on('exit', (code) => {
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(code ?? 0)
})
