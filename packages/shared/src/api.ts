import type { ChangeSummary, PresenceUser, SessionSummary } from './protocol'
import type { ModuleStatus, SessionRowStatus } from './events'

/** Shapes returned by the HTTP API. */

export interface UserPublic {
  id: string
  name: string
  email: string
  avatarColor: string
}

export interface ProjectSummary {
  id: string
  name: string
  description: string
  createdBy: string
  createdAt: string
  moduleCount: number
  members: UserPublic[]
  activeSessionCount: number
  lastActivityAt: string | null
}

export interface ModuleDto {
  id: string
  projectId: string
  name: string
  description: string
  emoji: string
  status: ModuleStatus
  sortOrder: number
  createdAt: string
}

export interface ProjectDetail {
  id: string
  name: string
  description: string
  createdBy: string
  createdAt: string
  members: UserPublic[]
  modules: ModuleDto[]
  activeSessions: SessionSummary[]
}

export interface SessionDetail {
  session: SessionSummary
  moduleName: string
  moduleEmoji: string
  events: import('./events').SessionEvent[]
  /** Highest persisted seq included in `events` (0 if none). */
  lastSeq: number
}

export interface BranchInfo {
  branchName: string
  aheadOfMain: number
  behindMain: number
  sessionId: string | null
  sessionTitle: string | null
  driverName: string | null
  driverAvatarColor: string | null
  moduleName: string | null
  moduleEmoji: string | null
  lastCommitSha: string | null
}

export interface FileTreeEntry {
  path: string
  type: 'file' | 'dir'
}

export interface MergeResult {
  ok: boolean
  merged: boolean
  hadConflicts: boolean
  message: string
  changeId: string | null
}

export type { ChangeSummary, PresenceUser, SessionSummary, SessionRowStatus }
