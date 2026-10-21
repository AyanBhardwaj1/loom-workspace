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

/**
 * F7 — the artifact a session ends with. Composed from the log's commit
 * explanations (which are provider-written whenever a real key is active),
 * so it needs no extra provider call and works identically in mock mode.
 */
export interface SessionDigest {
  title: string
  bullets: string[]
  files: string[]
  commitCount: number
  durationMs: number
}

export interface SessionDetail {
  session: SessionSummary
  moduleName: string
  moduleEmoji: string
  events: import('./events').SessionEvent[]
  /** Highest persisted seq included in `events` (0 if none). */
  lastSeq: number
  /** present once the session has ended (F7) */
  digest?: SessionDigest | null
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

// ── runtime AI provider settings ────────────────────────────────────────────

export type AiProviderKind = 'anthropic' | 'openrouter'
export type AiMode = 'mock' | AiProviderKind

export interface AiSettingsDto {
  /** What the agent runtime is using right now. */
  mode: AiMode
  /** Active model id (null in mock mode). */
  model: string | null
  /** Key hint like "sk-…abcd" (never the full key). */
  maskedKey: string | null
  /** Where the active config came from: pasted in the UI, the server env, or neither. */
  source: 'runtime' | 'env' | 'none'
  /** For openrouter/compatible providers: the API base URL in use. */
  baseUrl: string | null
  /** Reasoning setting for the active model (null = provider default). */
  reasoning: ReasoningSetting | null
}

/** Effort ladder OpenRouter models advertise, ordered weakest → strongest. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]
/** 'on'/'off' cover reasoning models that only expose a toggle, no ladder. */
export type ReasoningSetting = ReasoningEffort | 'on' | 'off'

export interface AiSettingsUpdate {
  provider: AiProviderKind
  /** omitted = reuse the stored key (only when the provider is unchanged) */
  apiKey?: string
  model?: string
  /** Any OpenAI-compatible endpoint (OpenRouter default; Ollama, vLLM, LM Studio work too). */
  baseUrl?: string
  /** null/undefined = provider default. Only meaningful for openrouter. */
  reasoning?: ReasoningSetting | null
}

/** One curated Claude model for the Anthropic-tab picker. */
export interface ClaudeModelDto {
  id: string
  name: string
  blurb: string
  /** $ per million tokens */
  promptPrice: number
  completionPrice: number
  /** effort levels the model accepts, low → max; [] = no effort control */
  efforts: ReasoningEffort[]
  /** what the API does when no effort is sent */
  defaultEffort: string
}

/** One OpenRouter catalog row, trimmed to what the model picker shows. */
export interface OpenRouterModelDto {
  id: string
  name: string
  contextLength: number | null
  /** $ per million tokens; null = unknown, 0 = free. */
  promptPrice: number | null
  completionPrice: number | null
  /** null = the model cannot reason at all. */
  reasoning: {
    /** true = the model always reasons (no off switch). */
    mandatory: boolean
    /** Efforts this model accepts, ordered low → max; [] = on/off toggle only. */
    efforts: ReasoningEffort[]
    defaultEffort: string | null
  } | null
}
