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
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5'

interface StoredAiSettings {
  provider: 'anthropic' | 'openrouter'
  apiKey: string
  model: string
  baseUrl?: string
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
    }
  }

  /**
   * Validate the pasted key with a live 1-token call, persist it, apply it.
   * Returns the new state or a human-readable error.
   */
  async configure(update: AiSettingsUpdate): Promise<{ ok: true; settings: AiSettingsDto } | { ok: false; error: string }> {
    const stored: StoredAiSettings =
      update.provider === 'anthropic'
        ? {
            provider: 'anthropic',
            apiKey: update.apiKey.trim(),
            model: update.model?.trim() || this.config.anthropicModel,
          }
        : {
            provider: 'openrouter',
            apiKey: update.apiKey.trim(),
            model: update.model?.trim() || DEFAULT_OPENROUTER_MODEL,
            baseUrl: update.baseUrl?.trim() || OPENROUTER_BASE_URL,
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
      this.provider = new AnthropicAgentProvider({ apiKey: stored.apiKey, model: stored.model })
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
      this.provider = new OpenAICompatProvider(opts)
      this.summarizer = new OpenAICompatSummarizer(opts)
      this.conflictResolver = makeOpenAICompatConflictResolver(opts)
      this.baseUrl = stored.baseUrl ?? OPENROUTER_BASE_URL
    }
    this.mode = stored.provider
    this.model = stored.model
    this.source = 'runtime'
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
    } else {
      this.provider = new MockAgentProvider({ fast: this.opts.fastMock })
      this.summarizer = new TemplateSummarizer()
      this.conflictResolver = null
      this.mode = 'mock'
      this.model = null
      this.source = 'none'
      this.maskedKey = null
      this.baseUrl = null
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

function maskKey(key: string): string {
  return key.length <= 8 ? 'sk-…' : `${key.slice(0, 3)}…${key.slice(-4)}`
}

async function validateAnthropic(apiKey: string, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = new Anthropic({ apiKey })
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/401|authentication/i.test(message)) return { ok: false, error: 'Anthropic rejected that API key.' }
    if (/404|model/i.test(message)) return { ok: false, error: `Anthropic rejected the model id: ${message.slice(0, 200)}` }
    return { ok: false, error: `Could not verify the key with Anthropic: ${message.slice(0, 200)}` }
  }
}
