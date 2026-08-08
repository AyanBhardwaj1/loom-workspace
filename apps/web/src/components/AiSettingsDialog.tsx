import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { clsx } from 'clsx'
import type { AiProviderKind, AiSettingsDto } from '@loom/shared'
import { api } from '../lib/api'
import { Dialog, Spinner } from './ui'

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

/** Chip for headers: what is the agent, right now. */
export function AgentModeChip({ onClick }: { onClick?: () => void }) {
  const settings = useAiSettings()
  if (!settings.data) return null
  const s = settings.data
  const label = s.mode === 'mock' ? 'mock agent' : `${s.mode === 'anthropic' ? 'claude' : 'llm'} · ${s.model}`
  return (
    <button
      onClick={onClick}
      title={
        s.mode === 'mock'
          ? 'Simulated agent (no API key configured) — click to add one'
          : `Real model via ${s.mode} (${s.source === 'env' ? 'server env key' : 'key set in the UI'})`
      }
      className={clsx(
        'chip max-w-[14rem] truncate text-[10px] transition-colors hover:border-accent',
        s.mode === 'mock' ? 'text-ink-300' : 'border-accent/50 text-accent-soft',
      )}
    >
      {s.mode === 'mock' ? '🤖' : '✨'} {label}
    </button>
  )
}

export function AiSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const settings = useAiSettings()
  const [provider, setProvider] = useState<AiProviderKind>('anthropic')
  const [apiKey, setApiKey] = useState('')
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
      setError(err instanceof Error ? err.message : 'Could not save the key')
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
      setError(err instanceof Error ? err.message : 'Could not reset')
    } finally {
      setBusy(false)
    }
  }

  const current = settings.data

  return (
    <Dialog open={open} onClose={onClose} title="AI provider">
      <div className="space-y-4">
        {current && (
          <div className="rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-2.5 text-xs">
            <span className="text-ink-400">Currently: </span>
            {current.mode === 'mock' ? (
              <span className="text-ink-100">built-in mock agent (free, no key)</span>
            ) : (
              <span className="text-accent-soft">
                {current.mode} · {current.model} · key {current.maskedKey}
                {current.source === 'env' ? ' (from server env)' : ''}
              </span>
            )}
          </div>
        )}

        <div className="flex gap-2">
          {(Object.keys(PROVIDER_INFO) as AiProviderKind[]).map((p) => (
            <button
              key={p}
              onClick={() => setProvider(p)}
              className={clsx(
                'btn flex-1 px-3 py-2 text-xs',
                provider === p ? 'bg-accent text-ink-950' : 'btn-secondary',
              )}
            >
              {PROVIDER_INFO[p].label}
            </button>
          ))}
        </div>

        <div className="space-y-2.5">
          <input
            type="password"
            className="input"
            placeholder={`${PROVIDER_INFO[provider].label} API key (${PROVIDER_INFO[provider].keyPlaceholder})`}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="off"
          />
          <input
            className="input"
            placeholder={`Model — ${PROVIDER_INFO[provider].modelPlaceholder}`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          {provider === 'openrouter' && (
            <input
              className="input"
              placeholder="Base URL — https://openrouter.ai/api/v1 (default; any OpenAI-compatible endpoint works)"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          )}
        </div>

        {error && <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-3.5 py-2.5 text-xs text-red-300">{error}</div>}
        {saved && (
          <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 px-3.5 py-2.5 text-xs text-emerald-200">
            Key verified and active — every session now chats with the real model. New messages in any
            open session use it immediately.
          </div>
        )}

        <div className="flex items-center gap-2">
          <button onClick={() => void save()} disabled={busy || !apiKey.trim()} className="btn-primary flex-1">
            {busy ? <Spinner className="h-4 w-4" /> : 'Verify & use this key'}
          </button>
          {current && current.mode !== 'mock' && current.source === 'runtime' && (
            <button onClick={() => void useMock()} disabled={busy} className="btn-secondary text-xs">
              Use mock instead
            </button>
          )}
        </div>

        <p className="text-[10px] leading-relaxed text-ink-400">
          The key is checked with a 1-token test call, then stored in this Loom server's own database and
          used only to call your chosen provider. It never reaches other users' browsers — teammates just
          see the agent get smarter.
        </p>
      </div>
    </Dialog>
  )
}
