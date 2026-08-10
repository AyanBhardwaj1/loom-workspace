import { Command } from 'cmdk'
import { Check, ChevronsUpDown, Eye, EyeOff, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BRAND,
  type AiProviderKind,
  type AiSettingsDto,
  type OpenRouterModelDto,
  type ReasoningSetting,
} from '@loom/shared'
import { api } from '../lib/api'
import { Modal } from './overlay'
import { Button, SegmentedControl, Spinner, StatusDot, cn } from './primitives'

const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-4.5'

const PROVIDER_INFO: Record<AiProviderKind, { label: string; keyPlaceholder: string; modelPlaceholder: string }> = {
  anthropic: {
    label: 'Anthropic',
    keyPlaceholder: 'sk-ant-…',
    modelPlaceholder: 'claude-sonnet-4-5 (default)',
  },
  openrouter: {
    label: 'OpenRouter / compatible',
    keyPlaceholder: 'sk-or-…',
    modelPlaceholder: `${DEFAULT_OPENROUTER_MODEL} (default)`,
  },
}

const REASONING_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export function useAiSettings() {
  return useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api.get<AiSettingsDto>('/api/settings/ai'),
    staleTime: 15_000,
  })
}

function useOpenRouterModels(enabled: boolean) {
  return useQuery({
    queryKey: ['openrouter-models'],
    queryFn: () => api.get<{ models: OpenRouterModelDto[] }>('/api/settings/openrouter/models'),
    enabled,
    staleTime: 60 * 60 * 1000,
  })
}

/** Header chip: what the agent is, right now. Honest status, no decoration. */
export function AgentModeChip({ onClick }: { onClick?: () => void }) {
  const settings = useAiSettings()
  if (!settings.data) return null
  const s = settings.data
  const mock = s.mode === 'mock'
  return (
    <button
      onClick={onClick}
      title={
        mock
          ? 'Simulated agent (no API key configured) — click to add one'
          : `Real model via ${s.mode} (${s.source === 'env' ? 'server env key' : 'key set in the UI'})${s.reasoning ? ` · reasoning ${s.reasoning}` : ''}`
      }
      className={cn(
        'inline-flex h-6 max-w-[15rem] items-center gap-1.5 truncate rounded-full border px-2.5 text-small transition-colors duration-micro',
        mock ? 'border-hairline text-secondary hover:border-hairline-hover' : 'border-lav-border text-lav-300 hover:border-lav-400',
      )}
    >
      <StatusDot tone={mock ? 'idle' : 'accent'} />
      {mock ? 'Mock agent' : `${s.mode === 'anthropic' ? 'Claude' : 'LLM'} · ${s.model}${s.reasoning ? ` · ${s.reasoning}` : ''}`}
    </button>
  )
}

function fmtContext(n: number | null): string | null {
  if (n == null) return null
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M ctx`
  return `${Math.round(n / 1000)}k ctx`
}

function fmtPrice(m: OpenRouterModelDto): string | null {
  if (m.promptPrice == null && m.completionPrice == null) return null
  if ((m.promptPrice ?? 0) === 0 && (m.completionPrice ?? 0) === 0) return 'free'
  return `$${m.promptPrice ?? '?'} / $${m.completionPrice ?? '?'} per M`
}

/**
 * The whole-catalog model picker: a loom-input-shaped trigger that expands
 * into an inline cmdk search over every OpenRouter model. Unknown ids stay
 * typeable — the "use custom id" row is always reachable.
 */
function ModelCombobox({
  models,
  value,
  onPick,
  open,
  onOpenChange,
}: {
  models: OpenRouterModelDto[]
  value: string
  onPick: (id: string) => void
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  // click-away collapses the list (Escape is handled at the dialog level)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onOpenChange])

  useEffect(() => {
    if (!open) setSearch('')
  }, [open])

  const pick = (id: string) => {
    onPick(id)
    onOpenChange(false)
  }

  const exactMatch = models.some((m) => m.id === search.trim())

  return (
    <div ref={wrapRef}>
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="loom-input flex items-center justify-between gap-2 text-left font-mono text-code"
      >
        <span className={cn('truncate', !value && 'text-tertiary')}>{value || PROVIDER_INFO.openrouter.modelPlaceholder}</span>
        <ChevronsUpDown size={14} strokeWidth={1.5} className="shrink-0 text-tertiary" />
      </button>
      {open && (
        <Command loop shouldFilter className="mt-1.5 overflow-hidden rounded border border-hairline bg-inset">
          <div className="flex items-center gap-2 border-b border-hairline px-2.5">
            <Search size={14} strokeWidth={1.5} className="shrink-0 text-tertiary" />
            <Command.Input
              autoFocus
              value={search}
              onValueChange={setSearch}
              placeholder={`Search ${models.length} models…`}
              className="h-9 w-full bg-transparent text-ui text-primary outline-none placeholder:text-tertiary"
            />
          </div>
          <Command.List className="max-h-60 overflow-y-auto p-1">
            <Command.Empty className="px-2.5 py-5 text-center text-small text-tertiary">
              No model matches — you can still use the id below.
            </Command.Empty>
            {models.map((m) => {
              const meta = [m.name !== m.id ? m.name : null, fmtContext(m.contextLength), fmtPrice(m)]
                .filter(Boolean)
                .join(' · ')
              return (
                <Command.Item
                  key={m.id}
                  value={`${m.id} ${m.name}`}
                  onSelect={() => pick(m.id)}
                  className="relative flex cursor-pointer select-none flex-col gap-0.5 rounded px-2.5 py-1.5 data-[selected=true]:bg-lav-fill"
                >
                  <span aria-hidden className="palette-rule absolute bottom-1 left-0 top-1 w-[2px] rounded-full bg-lav-500" />
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-code text-primary">{m.id}</span>
                    {m.id === value && <Check size={14} strokeWidth={1.5} className="ml-auto shrink-0 text-lav-400" />}
                  </span>
                  {meta && <span className="truncate text-small text-tertiary">{meta}</span>}
                </Command.Item>
              )
            })}
          </Command.List>
          {/* fixed footer, outside cmdk's ranked list: Enter always picks the
              best catalog match; this stays the escape hatch for unlisted ids */}
          {search.trim() && !exactMatch && (
            <button
              type="button"
              onClick={() => pick(search.trim())}
              className="flex w-full items-center gap-1 truncate border-t border-hairline px-2.5 py-2 text-left text-small text-secondary transition-colors duration-micro hover:bg-lav-fill hover:text-primary"
            >
              Use “<span className="font-mono text-code">{search.trim()}</span>” as a custom model id
            </button>
          )}
        </Command>
      )}
    </div>
  )
}

/**
 * Reasoning, from low to max — but only the levels the chosen model actually
 * advertises in the OpenRouter catalog. Toggle-only models get On/Off;
 * always-on models get a note; unknown ids get the full ladder, unverified.
 */
function ReasoningControl({
  entry,
  modelId,
  value,
  onChange,
}: {
  entry: OpenRouterModelDto | undefined
  modelId: string
  value: ReasoningSetting | null
  onChange: (v: ReasoningSetting | null) => void
}) {
  const info = entry?.reasoning
  if (entry && info === null) {
    return (
      <p className="text-small text-tertiary">
        <span className="font-mono text-code">{modelId}</span> doesn’t do extended reasoning.
      </p>
    )
  }
  if (info && info.mandatory && info.efforts.length === 0) {
    return <p className="text-small text-tertiary">This model always reasons — it exposes no levels to pick.</p>
  }

  const efforts = info ? info.efforts : (['low', 'medium', 'high', 'xhigh', 'max'] as const)
  const toggleOnly = info !== undefined && info !== null && info.efforts.length === 0
  const options: Array<{ value: string; label: string; title?: string }> = [
    { value: 'auto', label: 'Auto', title: 'Let the provider decide' },
    ...(info?.mandatory ? [] : [{ value: 'off', label: 'Off', title: 'No reasoning tokens' }]),
    ...(toggleOnly
      ? [{ value: 'on', label: 'On', title: 'Reasoning enabled, default budget' }]
      : efforts.map((e) => ({ value: e, label: REASONING_LABELS[e] ?? e, title: `Reasoning effort: ${e}` }))),
  ]

  return (
    <div className="space-y-1.5">
      <SegmentedControl
        size="sm"
        className="w-full"
        value={value ?? 'auto'}
        onChange={(v) => onChange(v === 'auto' ? null : (v as ReasoningSetting))}
        options={options}
      />
      <p className="text-small text-tertiary">
        {info?.defaultEffort
          ? `Auto uses the model’s default (${info.defaultEffort}). Higher levels think longer and cost more.`
          : entry
            ? 'Higher levels think longer and cost more.'
            : 'Unknown model — levels shown unverified; the provider may reject some.'}
      </p>
    </div>
  )
}

export function AiSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const settings = useAiSettings()
  const [provider, setProvider] = useState<AiProviderKind>('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [reasoning, setReasoning] = useState<ReasoningSetting | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // a non-OpenRouter base URL means the catalog (and its reasoning ladders)
  // doesn't apply — fall back to the plain text field
  const customEndpoint = baseUrl.trim() !== '' && !/openrouter\.ai/.test(baseUrl)
  const catalogQuery = useOpenRouterModels(open && provider === 'openrouter' && !customEndpoint)
  const models = catalogQuery.data?.models ?? []
  const effectiveModel = model.trim() || DEFAULT_OPENROUTER_MODEL
  const catalogEntry = models.find((m) => m.id === effectiveModel)

  useEffect(() => {
    if (open) {
      setError(null)
      setSaved(false)
      setApiKey('')
      setShowKey(false)
      setPickerOpen(false)
      if (settings.data && settings.data.mode !== 'mock') {
        setProvider(settings.data.mode)
        setModel(settings.data.model ?? '')
        setReasoning(settings.data.reasoning ?? null)
      }
    }
  }, [open])

  const save = async () => {
    if (!apiKey.trim() || busy) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await api.put<AiSettingsDto>('/api/settings/ai', {
        provider,
        apiKey: apiKey.trim(),
        model: model.trim() || undefined,
        baseUrl: provider === 'openrouter' && baseUrl.trim() ? baseUrl.trim() : undefined,
        reasoning: provider === 'openrouter' && !customEndpoint ? reasoning : undefined,
      })
      await queryClient.invalidateQueries({ queryKey: ['ai-settings'] })
      setSaved(true)
      setApiKey('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the key. Check it and try again.')
    } finally {
      setBusy(false)
    }
  }

  const useMock = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.del<AiSettingsDto>('/api/settings/ai')
      await queryClient.invalidateQueries({ queryKey: ['ai-settings'] })
      setSaved(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset.')
    } finally {
      setBusy(false)
    }
  }

  const current = settings.data

  return (
    <Modal
      open={open}
      // first Escape / backdrop click collapses an open model list; the next closes the dialog
      onClose={() => (pickerOpen ? setPickerOpen(false) : onClose())}
      title="AI provider"
    >
      <div className="space-y-4">
        {/* honest status row */}
        {current && (
          <div className="flex items-center gap-2 rounded border border-hairline bg-inset px-3 py-2 text-small">
            <StatusDot tone={current.mode === 'mock' ? 'idle' : 'ok'} />
            {current.mode === 'mock' ? (
              <span className="text-secondary">Mock agent — no key. The full product works, free.</span>
            ) : (
              <span className="text-secondary">
                <span className="text-ok">{current.mode === 'anthropic' ? 'Claude' : 'LLM'} — live.</span>{' '}
                <span className="font-mono">{current.model}</span>
                {current.reasoning ? <> · reasoning <span className="font-mono">{current.reasoning}</span></> : null} · key{' '}
                <span className="font-mono">{current.maskedKey}</span>
                {current.source === 'env' ? ' (server env)' : ''}
              </span>
            )}
          </div>
        )}

        <SegmentedControl
          value={provider}
          onChange={setProvider}
          className="w-full"
          options={(Object.keys(PROVIDER_INFO) as AiProviderKind[]).map((p) => ({
            value: p,
            label: PROVIDER_INFO[p].label,
          }))}
        />

        <div className="space-y-2.5">
          <label className="block">
            <span className="mb-1 block text-small font-medium text-secondary">API key</span>
            <span className="relative block">
              <input
                type={showKey ? 'text' : 'password'}
                className="loom-input pr-9 font-mono text-code"
                placeholder={PROVIDER_INFO[provider].keyPlaceholder}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? 'Hide the key' : 'Reveal the key'}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-tertiary transition-colors duration-micro hover:text-secondary"
              >
                {showKey ? <EyeOff size={14} strokeWidth={1.5} /> : <Eye size={14} strokeWidth={1.5} />}
              </button>
            </span>
          </label>

          <div className="block">
            <span className="mb-1 block text-small font-medium text-secondary">Model</span>
            {provider === 'openrouter' && !customEndpoint && models.length > 0 ? (
              <ModelCombobox
                models={models}
                value={model}
                onPick={(id) => {
                  setModel(id)
                  setReasoning(null)
                }}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
              />
            ) : (
              <>
                <input
                  className="loom-input font-mono text-code"
                  placeholder={PROVIDER_INFO[provider].modelPlaceholder}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
                {provider === 'openrouter' && !customEndpoint && catalogQuery.isLoading && (
                  <span className="mt-1 flex items-center gap-1.5 text-small text-tertiary">
                    <Spinner className="h-3 w-3" /> Loading the OpenRouter catalog…
                  </span>
                )}
                {provider === 'openrouter' && !customEndpoint && catalogQuery.isError && (
                  <span className="mt-1 block text-small text-tertiary">Catalog unavailable — type a model id.</span>
                )}
              </>
            )}
          </div>

          {provider === 'openrouter' && !customEndpoint && (
            <div className="block">
              <span className="mb-1 block text-small font-medium text-secondary">Reasoning</span>
              <ReasoningControl entry={catalogEntry} modelId={effectiveModel} value={reasoning} onChange={setReasoning} />
            </div>
          )}

          {provider === 'openrouter' && (
            <label className="block">
              <span className="mb-1 block text-small font-medium text-secondary">Base URL</span>
              <input
                className="loom-input font-mono text-code"
                placeholder="https://openrouter.ai/api/v1 (default; any OpenAI-compatible endpoint)"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              {customEndpoint && (
                <span className="mt-1 block text-small text-tertiary">
                  Custom endpoint — the OpenRouter catalog and reasoning levels don’t apply here.
                </span>
              )}
            </label>
          )}
        </div>

        {error && <div className="rounded border border-danger-border bg-danger-fill px-3 py-2 text-small text-danger">{error}</div>}
        {saved && (
          <div className="rounded border border-ok-border bg-ok-fill px-3 py-2 text-small text-ok">
            Key verified and active — every session now chats with the real model.
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button variant="primary" className="flex-1" onClick={() => void save()} disabled={busy || !apiKey.trim()}>
            {busy ? <Spinner className="h-4 w-4" /> : 'Save key'}
          </Button>
          {current && current.mode !== 'mock' && current.source === 'runtime' && (
            <Button variant="ghost" size="md" onClick={() => void useMock()} disabled={busy}>
              Use mock instead
            </Button>
          )}
        </div>

        <p className="text-small leading-relaxed text-tertiary">
          Checked with a 1-token test call, stored in this {BRAND} server's own database, and used only to call
          your chosen provider. It never reaches other users' browsers — teammates just see the agent get smarter.
        </p>
      </div>
    </Modal>
  )
}
