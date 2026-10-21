import Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import type { AgentProvider, AiSettingsDto, AiSettingsUpdate } from '@loom/shared'
import type { DbHandle } from '../db/client'
import type { ServerConfig } from '../env'
import { TemplateSummarizer, type Summarizer } from './summarizer'
import { AnthropicAgentProvider, AnthropicSummarizer, makeAnthropicConflictResolver } from './providers/anthropic'
import { MockAgentProvider } from './providers/mock'
import {
  makeOpenAICompatConflictResolver,
  OpenAICompatProvider,
  OpenAICompatSummarizer,
  OPENROUTER_BASE_URL,
  validateOpenAICompat,
} from './providers/openrouter'
import type { ConflictResolver } from './providers'

const SETTINGS_KEY = 'ai_provider'
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-opus-5.5'

interface StoredAiSettings {
  provider: 'anthropic' | 'openrouter'
  apiKey: string
  model: string
  baseUrl?: string
  /** effort level (both providers) or 'on'/'off' (OpenRouter toggles); null = provider default */
  reasoning?: string | null
}

/**
 * Mutable holder for the active agent stack. The orchestrator and merge
 * service read `runtime.provider` / `.summarizer` / `.conflictResolver` at
 * call time, so pasting a key in the UI swaps the model mid-flight — no
 * restart. Precedence: UI-configured key (persisted in app_settings) > server
 * env key > mock.
 */
export class AgentRuntime {
  provider: AgentProvider
  summarizer: Summarizer
  conflictResolver: ConflictResolver | null
  mode: AiSettingsDto['mode']
  model: string | null = null
  source: AiSettingsDto['source'] = 'none'
  baseUrl: string | null = null
  reasoning: AiSettingsDto['reasoning'] = null
  private maskedKey: string | null = null

  constructor(
    private config: ServerConfig,
    private dbh: DbHandle,
    private opts: { fastMock?: boolean } = {},
  ) {
    // placeholder assignment; applyEnvOrMock() sets the real stack
    this.provider = new MockAgentProvider({ fast: opts.fastMock })
    this.summarizer = new TemplateSummarizer()
    this.conflictResolver = null
    this.mode = 'mock'
    this.applyEnvOrMock()
  }

  /** Boot: restore a UI-configured provider persisted in app_settings. */
  async loadPersisted(): Promise<void> {
    const stored = await this.readStored()
    if (stored) this.applyStored(stored)
  }

  describe(): AiSettingsDto {
    return {
      mode: this.mode,
      model: this.model,
      maskedKey: this.maskedKey,
      source: this.source,
      baseUrl: this.baseUrl,
      reasoning: this.reasoning,
    }
  }

  /**
   * Validate the key (Models API lookup / 1-token call), persist it, apply it.
   * Returns the new state or a human-readable error.
   */
  async configure(update: AiSettingsUpdate): Promise<{ ok: true; settings: AiSettingsDto } | { ok: false; error: string }> {
    // a model/effort change on the same provider keeps the stored key — the
    // key never round-trips through the browser to change a dropdown
    let apiKey = update.apiKey?.trim() ?? ''
    let baseUrl = update.baseUrl?.trim() || undefined
    if (!apiKey) {
      const previous = await this.readStored()
      if (!previous || previous.provider !== update.provider) {
        return { ok: false, error: 'An API key is required for this provider.' }
      }
      // a reused key may only ever go to the endpoint it was saved for —
      // otherwise any member could redirect it to a host they control
      const previousBase = previous.baseUrl ?? OPENROUTER_BASE_URL
      if (baseUrl !== undefined && normalizeBase(baseUrl) !== normalizeBase(previousBase)) {
        return { ok: false, error: 'Paste the API key again to use a different endpoint.' }
      }
      apiKey = previous.apiKey
      baseUrl = previous.provider === 'openrouter' ? previousBase : undefined
    }
    const stored: StoredAiSettings =
      update.provider === 'anthropic'
        ? {
            provider: 'anthropic',
            apiKey,
            model: update.model?.trim() || this.config.anthropicModel,
            reasoning: update.reasoning ?? null,
          }
        : {
            provider: 'openrouter',
            apiKey,
            model: update.model?.trim() || DEFAULT_OPENROUTER_MODEL,
            baseUrl: baseUrl ?? OPENROUTER_BASE_URL,
            reasoning: update.reasoning ?? null,
          }

    const check =
      stored.provider === 'anthropic'
        ? await validateAnthropic(stored.apiKey, stored.model)
        : await validateOpenAICompat({ apiKey: stored.apiKey, model: stored.model, baseUrl: stored.baseUrl })
    if (!check.ok) return { ok: false, error: check.error }

    await this.writeStored(stored)
    this.applyStored(stored)
    return { ok: true, settings: this.describe() }
  }

  /** Forget the UI-configured key and fall back to env key or mock. */
  async clear(): Promise<AiSettingsDto> {
    const { db, t } = this.dbh
    await db.delete(t.appSettings).where(eq(t.appSettings.key, SETTINGS_KEY))
    this.applyEnvOrMock()
    return this.describe()
  }

  private applyStored(stored: StoredAiSettings): void {
    if (stored.provider === 'anthropic') {
      this.provider = new AnthropicAgentProvider({ apiKey: stored.apiKey, model: stored.model, effort: stored.reasoning ?? null })
      this.summarizer = new AnthropicSummarizer({
        apiKey: stored.apiKey,
        model: this.config.anthropicSummaryModel,
      })
      this.conflictResolver = makeAnthropicConflictResolver({
        ...this.config,
        anthropicApiKey: stored.apiKey,
        anthropicModel: stored.model,
      })
      this.baseUrl = null
    } else {
      const opts = { apiKey: stored.apiKey, model: stored.model, baseUrl: stored.baseUrl }
      // reasoning applies to agent turns only — summarizer/resolver stay fast
      this.provider = new OpenAICompatProvider({ ...opts, reasoning: stored.reasoning ?? null })
      this.summarizer = new OpenAICompatSummarizer(opts)
      this.conflictResolver = makeOpenAICompatConflictResolver(opts)
      this.baseUrl = stored.baseUrl ?? OPENROUTER_BASE_URL
    }
    this.mode = stored.provider
    this.model = stored.model
    this.source = 'runtime'
    this.reasoning = (stored.reasoning as AiSettingsDto['reasoning']) ?? null
    this.maskedKey = maskKey(stored.apiKey)
  }

  private applyEnvOrMock(): void {
    if (this.config.anthropicApiKey) {
      this.provider = new AnthropicAgentProvider({
        apiKey: this.config.anthropicApiKey,
        model: this.config.anthropicModel,
      })
      this.summarizer = new AnthropicSummarizer({
        apiKey: this.config.anthropicApiKey,
        model: this.config.anthropicSummaryModel,
      })
      this.conflictResolver = makeAnthropicConflictResolver(this.config)
      this.mode = 'anthropic'
      this.model = this.config.anthropicModel
      this.source = 'env'
      this.maskedKey = maskKey(this.config.anthropicApiKey)
      this.baseUrl = null
      this.reasoning = null
    } else {
      this.provider = new MockAgentProvider({ fast: this.opts.fastMock })
      this.summarizer = new TemplateSummarizer()
      this.conflictResolver = null
      this.mode = 'mock'
      this.model = null
      this.source = 'none'
      this.maskedKey = null
      this.baseUrl = null
      this.reasoning = null
    }
  }

  private async readStored(): Promise<StoredAiSettings | null> {
    const { db, t } = this.dbh
    const rows = await db.select().from(t.appSettings).where(eq(t.appSettings.key, SETTINGS_KEY))
    if (!rows[0]) return null
    try {
      return JSON.parse(rows[0].value) as StoredAiSettings
    } catch {
      return null
    }
  }

  private async writeStored(stored: StoredAiSettings): Promise<void> {
    const { db, t } = this.dbh
    await db.delete(t.appSettings).where(eq(t.appSettings.key, SETTINGS_KEY))
    await db.insert(t.appSettings).values({ key: SETTINGS_KEY, value: JSON.stringify(stored) })
  }
}

function normalizeBase(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase()
}

function maskKey(key: string): string {
  return key.length <= 8 ? 'sk-…' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

/**
 * Proves key + model with the Models API: an authenticated lookup of the
 * model id — no generation, no tokens billed.
 */
async function validateAnthropic(apiKey: string, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 15_000 })
    await client.models.retrieve(model)
    return { ok: true }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return { ok: false, error: 'Anthropic rejected that API key.' }
    }
    if (err instanceof Anthropic.NotFoundError) {
      return { ok: false, error: `Anthropic doesn't recognize the model id "${model}".` }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Could not verify the key with Anthropic: ${message.slice(0, 200)}` }
  }
}
