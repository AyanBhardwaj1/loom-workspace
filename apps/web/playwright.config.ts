import { defineConfig } from '@playwright/test'

const PORT = process.env.E2E_PORT ?? '4599'
const BASE_URL = `http://127.0.0.1:${PORT}`

/**
 * E2E runs against a single self-contained server (mock agent, temp data,
 * serving the built web). `pnpm e2e` builds the web first; this config boots
 * the server via e2e/serve.mjs and points the specs at it.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.mjs',
    url: `${BASE_URL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
