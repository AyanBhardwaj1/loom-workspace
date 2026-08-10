import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Monorepo root (apps/server/src → ../../..). */
export const REPO_ROOT = path.resolve(__dirname, '../../..')

loadDotenv({ path: path.join(REPO_ROOT, '.env') })
loadDotenv()

export interface ServerConfig {
  nodeEnv: string
  /** dev features: quick-login, ghost collaborator, simulate button */
  isDev: boolean
  port: number
  host: string
  /** all runtime data (repos, worktrees, sqlite db) lives under here */
  dataDir: string
  sqlitePath: string
  /** when set, Postgres is used instead of SQLite */
  databaseUrl: string | null
  /** C10 — when set, the EventBus rides Redis pub/sub (multi-instance) */
  redisUrl: string | null
  cookieSecret: string
  anthropicApiKey: string | null
  anthropicModel: string
  anthropicSummaryModel: string
  /** built frontend, served statically in production if present */
  webDistPath: string
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development'
  const dataDir = process.env.LOOM_DATA_DIR
    ? path.resolve(process.env.LOOM_DATA_DIR)
    : path.join(REPO_ROOT, 'data')
  return {
    nodeEnv,
    isDev: nodeEnv !== 'production',
    port: Number(process.env.PORT ?? 3001),
    host: process.env.HOST ?? '0.0.0.0',
    dataDir,
    sqlitePath: process.env.LOOM_SQLITE_PATH ?? path.join(dataDir, 'loom.db'),
    databaseUrl: process.env.DATABASE_URL ?? null,
    redisUrl: process.env.REDIS_URL ?? null,
    cookieSecret: process.env.COOKIE_SECRET ?? 'loom-dev-secret-do-not-use-in-prod',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    anthropicSummaryModel: process.env.ANTHROPIC_SUMMARY_MODEL || 'claude-3-5-haiku-latest',
    webDistPath: path.join(REPO_ROOT, 'apps/web/dist'),
    ...overrides,
  }
}
