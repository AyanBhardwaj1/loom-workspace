import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BRAND, type AiProviderKind, type AiSettingsDto } from '@loom/shared'
import { api } from '../lib/api'
import { Modal } from './overlay'
import { Button, SegmentedControl, Spinner, StatusDot, cn } from './primitives'

const PROVIDER_INFO: Record<AiProviderKind, { label: string; keyPlaceholder: string; modelPlaceholder: string }> = {
  anthropic: {
    label: 'Anthropic',
    keyPlaceholder: 'sk-ant-…',
    modelPlaceholder: 'claude-sonnet-4-5 (default)',
  },
  openrouter: {
    label: 'OpenRouter / compatible',
    keyPlaceholder: 'sk-or-…',
    modelPlaceholder: 'anthropic/claude-sonnet-4.5 (default)',
  },
}

export function useAiSettings() {
  return useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api.get<AiSettingsDto>('/api/settings/ai'),
    staleTime: 15_000,
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
          : `Real model via ${s.mode} (${s.source === 'env' ? 'server env key' : 'key set in the UI'})`
      }
      className={cn(
        'inline-flex h-6 max-w-[15rem] items-center gap-1.5 truncate rounded-full border px-2.5 text-small transition-colors duration-micro',
        mock ? 'border-hairline text-secondary hover:border-hairline-hover' : 'border-lav-border text-lav-300 hover:border-lav-400',
      )}
    >
      <StatusDot tone={mock ? 'idle' : 'accent'} />
      {mock ? 'Mock agent' : `${s.mode === 'anthropic' ? 'Claude' : 'LLM'} · ${s.model}`}
    </button>
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (open) {
      setError(null)
      setSaved(false)
      setApiKey('')
      setShowKey(false)
      if (settings.data && settings.data.mode !== 'mock') {
        setProvider(settings.data.mode)
        setModel(settings.data.model ?? '')
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
    <Modal open={open} onClose={onClose} title="AI provider">
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
                <span className="font-mono">{current.model}</span> · key <span className="font-mono">{current.maskedKey}</span>
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
          <label className="block">
            <span className="mb-1 block text-small font-medium text-secondary">Model</span>
            <input
              className="loom-input font-mono text-code"
              placeholder={PROVIDER_INFO[provider].modelPlaceholder}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </label>
          {provider === 'openrouter' && (
            <label className="block">
              <span className="mb-1 block text-small font-medium text-secondary">Base URL</span>
              <input
                className="loom-input font-mono text-code"
                placeholder="https://openrouter.ai/api/v1 (default; any OpenAI-compatible endpoint)"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
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
