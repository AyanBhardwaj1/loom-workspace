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

/* ----------------------------------------------------------------------------
 * Serverless platform (LOOM_PLATFORM=serverless, e.g. Vercel): no persistent
 * disk, no long-lived sockets, many instances. Files + history live in the DB
 * (a tiny content-addressed git), realtime rides an outbox, and cross-request
 * coordination (turn locks, stop requests, handoffs) lives in a TTL'd kv.
 * ------------------------------------------------------------------------- */

/** content-addressed file contents (sha1 of the content) */
export const vgitBlobs = pgTable('vgit_blobs', {
  hash: text('hash').primaryKey(),
  content: text('content').notNull(),
})

/** a snapshot: tree = JSON {path: blobHash}; parents = JSON [sha] */
export const vgitCommits = pgTable(
  'vgit_commits',
  {
    sha: text('sha').primaryKey(),
    repo: text('repo').notNull(),
    tree: text('tree').notNull(),
    parents: text('parents').notNull(),
    message: text('message').notNull(),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ repoIdx: index('vgit_commits_repo_idx').on(t.repo) }),
)

export const vgitRefs = pgTable(
  'vgit_refs',
  {
    repo: text('repo').notNull(),
    name: text('name').notNull(),
    sha: text('sha').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.repo, t.name] }) }),
)

/** which branch a checkout path holds (any instance can rebuild it in /tmp) */
export const vgitWorktrees = pgTable('vgit_worktrees', {
  path: text('path').primaryKey(),
  repo: text('repo').notNull(),
  branch: text('branch').notNull(),
})

/** realtime outbox: every bus message, read by long-polling clients */
export const rtOutbox = pgTable(
  'rt_outbox',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    topic: text('topic').notNull(),
    body: text('body').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({ createdIdx: index('rt_outbox_created_idx').on(t.createdAt) }),
)

/** one row per open browser tab: its subscriptions + presence heartbeat */
export const rtClients = pgTable(
  'rt_clients',
  {
    clientId: text('client_id').primaryKey(),
    userId: text('user_id').notNull(),
    projectIds: text('project_ids').notNull(),
    sessionIds: text('session_ids').notNull(),
    viewing: text('viewing'),
    viewingProject: text('viewing_project'),
    readingEventId: text('reading_event_id'),
    lastSeen: text('last_seen').notNull(),
  },
  (t) => ({ seenIdx: index('rt_clients_seen_idx').on(t.lastSeen) }),
)

/** short-lived coordination keys (turn leases, stop requests, wheel offers) */
export const rtKv = pgTable('rt_kv', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  expiresAt: text('expires_at').notNull(),
})

/* ----------------------------------------------------------------------------
 * External agents (Claude Code / Codex / Cursor on a laptop) join the room
 * through the MCP endpoint: a personal token, and the work they announce —
 * file paths and symbol names only, never contents.
 * ------------------------------------------------------------------------- */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
  },
  (t) => ({ hashIdx: uniqueIndex('agent_tokens_hash_idx').on(t.tokenHash) }),
)

export const externalWork = pgTable(
  'external_work',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    projectId: text('project_id').notNull(),
    agent: text('agent').notNull(),
    branch: text('branch').notNull(),
    /** JSON [{path, symbols}] */
    files: text('files').notNull(),
    summary: text('summary').notNull(),
    updatedAt: text('updated_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({ projectIdx: index('external_work_project_idx').on(t.projectId) }),
)
