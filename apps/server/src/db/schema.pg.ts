import { index, integer, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'

/**
 * Postgres mirror of schema.sqlite.ts — identical table names, column names
 * and value shapes (text ISO timestamps, text JSON). Keep the two files in
 * lockstep when changing the schema, and regenerate both migration sets with
 * `pnpm --filter @loom/server db:generate`.
 */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  avatarColor: text('avatar_color').notNull(),
  createdAt: text('created_at').notNull(),
})

export const authSessions = pgTable(
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

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  repoPath: text('repo_path').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: text('created_at').notNull(),
})

export const projectMembers = pgTable(
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

export const modules = pgTable(
  'modules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    emoji: text('emoji').notNull().default('📦'),
    status: text('status').notNull().default('idea'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ projectIdx: index('modules_project_idx').on(t.projectId) }),
)

export const sessions = pgTable(
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
    status: text('status').notNull().default('active'),
    branchName: text('branch_name').notNull(),
    worktreePath: text('worktree_path').notNull(),
    parentSessionId: text('parent_session_id'),
    forkedAtEventId: text('forked_at_event_id'),
    lastEventAt: text('last_event_at'),
    /** F7: JSON SessionDigest, set when the session ends */
    digest: text('digest'),
    /** F11: random share token; null = not shared (revoked) */
    shareToken: text('share_token'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    moduleIdx: index('sessions_module_idx').on(t.moduleId),
    projectIdx: index('sessions_project_idx').on(t.projectId),
  }),
)

export const sessionEvents = pgTable(
  'session_events',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    sessionSeqIdx: uniqueIndex('session_events_session_seq_idx').on(t.sessionId, t.seq),
    sessionIdx: index('session_events_session_idx').on(t.sessionId),
  }),
)

export const changes = pgTable(
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
    filesChanged: text('files_changed').notNull(),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => users.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ projectIdx: index('changes_project_idx').on(t.projectId, t.createdAt) }),
)


/** F13 — per-user notifications (forked your session, merged, annotation, handoff). */
export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(), // 'fork' | 'merge' | 'annotation' | 'handoff'
    text: text('text').notNull(),
    projectId: text('project_id'),
    sessionId: text('session_id'),
    readAt: text('read_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ userIdx: index('notifications_user_idx').on(t.userId, t.createdAt) }),
)

/** Tiny key-value store for runtime app settings (e.g. the AI provider key). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
