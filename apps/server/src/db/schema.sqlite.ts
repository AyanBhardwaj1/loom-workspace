import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * SQLite schema (the default zero-config local driver).
 *
 * Portability rule: every column is text or integer, timestamps are ISO-8601
 * strings, JSON payloads are serialized text. `schema.pg.ts` mirrors this
 * table-for-table and column-for-column, which is what lets the same query
 * code run against Postgres when DATABASE_URL is set.
 */

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatarColor: text('avatar_color').notNull(),
  createdAt: text('created_at').notNull(),
})

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({ tokenHashIdx: uniqueIndex('auth_sessions_token_hash_idx').on(t.tokenHash) }),
)

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  repoPath: text('repo_path').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: text('created_at').notNull(),
})

export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
  },
  (t) => ({ pk: primaryKey({ columns: [t.projectId, t.userId] }) }),
)

export const modules = sqliteTable(
  'modules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    emoji: text('emoji').notNull().default('📦'),
    status: text('status').notNull().default('idea'), // 'idea' | 'building' | 'stable'
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ projectIdx: index('modules_project_idx').on(t.projectId) }),
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    driverUserId: text('driver_user_id')
      .notNull()
      .references(() => users.id),
    title: text('title').notNull(),
    status: text('status').notNull().default('active'), // 'active' | 'idle' | 'ended'
    branchName: text('branch_name').notNull(),
    worktreePath: text('worktree_path').notNull(),
    parentSessionId: text('parent_session_id'),
    forkedAtEventId: text('forked_at_event_id'),
    lastEventAt: text('last_event_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    moduleIdx: index('sessions_module_idx').on(t.moduleId),
    projectIdx: index('sessions_project_idx').on(t.projectId),
  }),
)

export const sessionEvents = sqliteTable(
  'session_events',
  {
    /** ulid — sortable */
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    /** monotonic int per session */
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    /** JSON-serialized payload */
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    sessionSeqIdx: uniqueIndex('session_events_session_seq_idx').on(t.sessionId, t.seq),
    sessionIdx: index('session_events_session_idx').on(t.sessionId),
  }),
)

export const changes = sqliteTable(
  'changes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    commitSha: text('commit_sha').notNull(),
    branchName: text('branch_name').notNull(),
    technicalSummary: text('technical_summary').notNull(),
    plainExplanation: text('plain_explanation').notNull(),
    /** JSON array: [{ path, changeKind, additions, deletions }] */
    filesChanged: text('files_changed').notNull(),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ projectIdx: index('changes_project_idx').on(t.projectId, t.createdAt) }),
)

/** Tiny key-value store for runtime app settings (e.g. the AI provider key). */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
