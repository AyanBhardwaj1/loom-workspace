import { startServer } from './app'
import { loadConfig } from './env'
import { createServices } from './services'

async function main(): Promise<void> {
  const config = loadConfig()
  const services = await createServices(config)
  const server = await startServer(services)

  const mode =
    services.agentMode === 'anthropic'
      ? `real Claude (${config.anthropicModel})`
      : 'mock agent (set ANTHROPIC_API_KEY for real Claude)'

  console.log(`
  ┌─────────────────────────────────────────────────┐
  │  Loom server                                    │
  │  http://localhost:${String(server.port).padEnd(5)}                        │
  │  ws:   /ws · api: /api · agent: ${services.agentMode.padEnd(9)}       │
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
