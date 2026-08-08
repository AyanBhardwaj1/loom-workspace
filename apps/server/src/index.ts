import { startServer } from './app'
import { loadConfig } from './env'
import { createServices } from './services'

async function main(): Promise<void> {
  const config = loadConfig()
  const services = await createServices(config)
  const server = await startServer(services)

  const mode =
    services.runtime.mode === 'mock'
      ? 'mock agent (set ANTHROPIC_API_KEY or paste a key in Settings for a real LLM)'
      : `${services.runtime.mode} (${services.runtime.model})`

  console.log(`
  ┌─────────────────────────────────────────────────┐
  │  Loom server                                    │
  │  http://localhost:${String(server.port).padEnd(5)}                        │
  │  ws:   /ws · api: /api · agent: ${services.runtime.mode.padEnd(9)}       │
  └─────────────────────────────────────────────────┘
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
