import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { REASONING_EFFORTS, type OpenRouterModelDto, type ReasoningEffort } from '@loom/shared'
import { CLAUDE_MODELS } from '../agent/claudeModels'
import type { Services } from '../services'
import { makeRequireUser, parseBody } from './helpers'

const updateSchema = z.object({
  provider: z.enum(['anthropic', 'openrouter']),
  /** omitted = keep the stored key (model/effort change on the same provider) */
  apiKey: z.string().min(8).max(400).optional(),
  model: z.string().max(200).optional(),
  baseUrl: z.string().url().max(300).optional(),
  reasoning: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'on', 'off']).nullish(),
})

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const MODELS_TTL_MS = 60 * 60 * 1000

/** The handful of upstream fields the picker needs; everything else ignored. */
const upstreamModelSchema = z.object({
  id: z.string(),
  name: z.string().nullish(),
  context_length: z.number().nullish(),
  pricing: z.object({ prompt: z.string().nullish(), completion: z.string().nullish() }).nullish(),
  reasoning: z
    .object({
      mandatory: z.boolean().nullish(),
      supported_efforts: z.array(z.string()).nullish(),
      default_effort: z.string().nullish(),
    })
    .nullish(),
})

/** "0.00001" per token → 10 ($ per million), rounded to cents. */
function perMillion(perToken: string | null | undefined): number | null {
  if (perToken == null) return null
  const n = Number(perToken)
  return Number.isFinite(n) ? Math.round(n * 1e6 * 100) / 100 : null
}

function trimModel(raw: unknown): OpenRouterModelDto | null {
  const parsed = upstreamModelSchema.safeParse(raw)
  if (!parsed.success) return null
  const m = parsed.data
  return {
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? null,
    promptPrice: perMillion(m.pricing?.prompt),
    completionPrice: perMillion(m.pricing?.completion),
    reasoning: m.reasoning
      ? {
          mandatory: m.reasoning.mandatory ?? false,
          efforts: REASONING_EFFORTS.filter((e): e is ReasoningEffort =>
            (m.reasoning?.supported_efforts ?? []).includes(e),
          ),
          defaultEffort: m.reasoning.default_effort ?? null,
        }
      : null,
  }
}

/**
 * Runtime AI provider settings: paste a key in the UI → the whole server
 * switches from the mock to a real LLM, live, no restart. The key is stored
 * in the app's own database (this is a self-hosted tool) and never echoed
 * back — GET only returns a masked hint.
 */
export async function settingsRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const requireUser = makeRequireUser(services)

  app.get('/api/settings/ai', { preHandler: requireUser }, async () => {
    return services.runtime.describe()
  })

  app.put('/api/settings/ai', { preHandler: requireUser }, async (req, reply) => {
    const body = parseBody(updateSchema, req.body, reply)
    if (!body) return
    const res = await services.runtime.configure(body)
    if (!res.ok) return reply.code(400).send({ error: res.error })
    return res.settings
  })

  app.delete('/api/settings/ai', { preHandler: requireUser }, async () => {
    return services.runtime.clear()
  })

  // the curated current-Claude list for the Anthropic tab (static: no key needed)
  app.get('/api/settings/anthropic/models', { preHandler: requireUser }, async () => ({ models: CLAUDE_MODELS }))

  // The full OpenRouter catalog (~400 models) for the searchable picker,
  // proxied so the browser never talks cross-origin. Cached an hour per
  // process; a stale copy beats a 502 if OpenRouter hiccups.
  let modelsCache: { at: number; models: OpenRouterModelDto[] } | null = null
  app.get('/api/settings/openrouter/models', { preHandler: requireUser }, async (_req, reply) => {
    if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
      return { models: modelsCache.models }
    }
    try {
      const res = await fetch(OPENROUTER_MODELS_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`upstream ${res.status}`)
      const body = (await res.json()) as { data?: unknown[] }
      const models = (body.data ?? [])
        .map(trimModel)
        .filter((m): m is OpenRouterModelDto => m !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
      if (models.length === 0) throw new Error('upstream returned an empty catalog')
      modelsCache = { at: Date.now(), models }
      return { models }
    } catch (err) {
      if (modelsCache) return { models: modelsCache.models }
      app.log.warn({ err }, 'openrouter model catalog fetch failed')
      return reply.code(502).send({ error: 'Could not load the OpenRouter catalog — type a model id instead.' })
    }
  })
}
