import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, type ServerConfig } from '../src/env'
import { createServices, type Services } from '../src/services'

export interface TestContext {
  services: Services
  config: ServerConfig
  cleanup: () => Promise<void>
}

/** Isolated services on a temp dir + temp sqlite db, with the fast (no-delay) mock agent. */
export async function makeTestServices(): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-'))
  const config = loadConfig({
    nodeEnv: 'test',
    isDev: true,
    dataDir: dir,
    sqlitePath: path.join(dir, 'test.db'),
    databaseUrl: null,
    anthropicApiKey: null,
  })
  const services = await createServices(config, { fastMock: true })
  return {
    services,
    config,
    cleanup: async () => {
      await services.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

export async function makeUser(services: Services, name: string, email: string) {
  const res = await services.auth.signup(name, email, 'password-123')
  if (!res.ok) throw new Error(res.error)
  return res.user
}
