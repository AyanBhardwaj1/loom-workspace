import { BRAND } from '@loom/shared'
import { startServer } from './app'
import { loadConfig } from './env'
import { runWorktreeGc } from './scripts/gc'
import { createServices } from './services'

async function main(): Promise<void> {
  const config = loadConfig()
  // LOOM_FAST_MOCK=1 removes the mock agent's artificial delays (used by the E2E)
  const services = await createServices(config, { fastMock: process.env.LOOM_FAST_MOCK === '1' })
  const server = await startServer(services)

  // C11 — daily worktree GC (LOOM_GC_DAYS, default 14; 0 disables)
  const gcDays = Number(process.env.LOOM_GC_DAYS ?? 14)
  if (gcDays > 0) {
    const gcTimer = setInterval(() => {
      runWorktreeGc(services.dbh, { days: gcDays }).catch((err) => console.error('[gc]', err))
    }, 24 * 60 * 60 * 1000)
    gcTimer.unref()
  }

  const mode =
    services.runtime.mode === 'mock'
      ? 'mock agent (set ANTHROPIC_API_KEY or paste a key in Settings for a real LLM)'
      : `${services.runtime.mode} (${services.runtime.model})`

  console.log(`
  ${BRAND} server
  http://localhost:${server.port}
  ws: /ws · api: /api · agent: ${services.runtime.mode}
  agent provider: ${mode}
  data dir:       ${config.dataDir}
  database:       ${config.databaseUrl ? 'postgres' : `sqlite (${config.sqlitePath})`}
`)

  const shutdown = async () => {
    console.log('\nShutting down…')
    await server.stop().catch(() => {})
    await services.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
