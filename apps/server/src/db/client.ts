import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import type { ServerConfig } from '../env'
import * as pgSchema from './schema.pg'
import * as sqliteSchema from './schema.sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle')

export type DbSchema = typeof sqliteSchema
export type Db = BetterSQLite3Database<DbSchema>

export interface DbHandle {
  db: Db
  t: DbSchema
  dialect: 'sqlite' | 'pg'
  close(): Promise<void> | void
}

/**
 * Creates the database handle. SQLite (better-sqlite3) by default for
 * zero-config local runs; Postgres when DATABASE_URL is set.
 *
 * The pg schema mirrors the sqlite schema exactly — same table/column names,
 * only text + integer columns, ISO-string timestamps, JSON as text — so the
 * handle exposes both drivers under one static type and all query code has a
 * single path. (Drizzle queries are thenable in both drivers, so `await`
 * works uniformly.)
 */
export async function createDb(config: ServerConfig): Promise<DbHandle> {
  if (config.databaseUrl) {
    const pool = new pg.Pool({ connectionString: config.databaseUrl })
    const db = drizzlePg(pool, { schema: pgSchema })
    await migratePg(db, { migrationsFolder: path.join(MIGRATIONS_DIR, 'pg') })
    return {
      db: db as unknown as Db,
      t: pgSchema as unknown as DbSchema,
      dialect: 'pg',
      close: () => pool.end(),
    }
  }

  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true })
  const sqlite = new Database(config.sqlitePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzleSqlite(sqlite, { schema: sqliteSchema })
  migrateSqlite(db, { migrationsFolder: path.join(MIGRATIONS_DIR, 'sqlite') })
  return {
    db,
    t: sqliteSchema,
    dialect: 'sqlite',
    close: () => {
      sqlite.close()
    },
  }
}
