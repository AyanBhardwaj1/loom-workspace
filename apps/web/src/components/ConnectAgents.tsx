import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Plug } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import { Modal } from './overlay'
import { Button } from './primitives'

interface TokenRow {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
}

/** opens the "connect your own coding agent" dialog */
export function ConnectAgentsButton({ variant = 'outline' }: { variant?: 'outline' | 'ghost' }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        <Plug size={14} strokeWidth={1.75} aria-hidden /> Connect your agent
      </Button>
      <ConnectAgentsDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/**
 * Each teammate keeps their own Claude Code, Codex or Cursor. One token
 * connects it to Loom over MCP: it announces what it's changing (names, not
 * contents), reads the radar before touching shared files, and can suggest
 * to a session's driver. Tokens are shown once and stored only as hashes.
 */
export function ConnectAgentsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const tokens = useQuery({ queryKey: ['agent-tokens'], queryFn: () => api.get<{ tokens: TokenRow[] }>('/api/agent-tokens'), enabled: open })
  const [name, setName] = useState('')
  const [fresh, setFresh] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameId = useId()
  const url = `${location.origin}/api/mcp`

  const create = async () => {
    setBusy(true)
    try {
      const res = await api.post<{ token: string }>('/api/agent-tokens', { name: name.trim() || 'My coding agent' })
      setFresh(res.token)
      setName('')
      void qc.invalidateQueries({ queryKey: ['agent-tokens'] })
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not create a token')
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (id: string) => {
    await api.del(`/api/agent-tokens/${id}`)
    void qc.invalidateQueries({ queryKey: ['agent-tokens'] })
    toast('Token revoked — that agent is disconnected')
  }

  const token = fresh ?? '<your token>'
  const claude = `claude mcp add --transport http loom ${url} --header "Authorization: Bearer ${token}"`
  const cursor = JSON.stringify({ mcpServers: { loom: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)

  return (
    <Modal open={open} onClose={() => { setFresh(null); onClose() }} title="Connect your coding agent" width={640}>
      <p className="text-small text-secondary">
        Keep the agent you already use. Connected, it tells the team what it&rsquo;s changing (file and function names — never contents), checks the
        radar before touching shared files, and hears about conflicts while they&rsquo;re small. It can suggest to a Loom session&rsquo;s driver; it can
        never run anything there on its own.
      </p>

      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <label htmlFor={nameId} className="flex-1">
          <span className="telemetry text-tertiary">Name this connection</span>
          <input id={nameId} name="token-name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} placeholder="MacBook — Claude Code…" maxLength={60} className="loom-input mt-1" />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create token'}
        </Button>
      </form>

      {fresh && (
        <div role="status" className="mt-3 border-2 border-signal-500 bg-surface p-3">
          <div className="telemetry text-signal-300">Copy it now — it won&rsquo;t be shown again</div>
          <CopyLine text={fresh} label="Copy token" />
        </div>
      )}

      <h3 className="telemetry mt-5 text-primary">Claude Code</h3>
      <CopyLine text={claude} label="Copy Claude Code command" />
      <h3 className="telemetry mt-4 text-primary">Cursor · .cursor/mcp.json</h3>
      <CopyLine text={cursor} label="Copy Cursor config" multiline />
      <h3 className="telemetry mt-4 text-primary">Codex and other MCP clients</h3>
      <p className="mt-1 text-small text-secondary">
        Add an HTTP MCP server at <span className="font-mono text-code-sm text-primary">{url}</span> with the header{' '}
        <span className="font-mono text-code-sm text-primary">Authorization: Bearer {fresh ? '…' : '<your token>'}</span>.
      </p>

      <h3 className="telemetry mt-6 text-primary">Your connections</h3>
      {tokens.data && tokens.data.tokens.length > 0 ? (
        <ul className="mt-2 divide-y divide-hairline border border-hairline-strong">
          {tokens.data.tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-small">
              <span className="min-w-0 flex-1 truncate text-primary">{t.name}</span>
              <span className="telemetry text-tertiary">{t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : 'never used'}</span>
              <Button size="sm" variant="danger" onClick={() => void revoke(t.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-small text-tertiary">None yet.</p>
      )}
    </Modal>
  )
}

function CopyLine({ text, label, multiline = false }: { text: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <pre className={`min-w-0 flex-1 overflow-x-auto border border-hairline bg-inset px-2.5 py-2 font-mono text-code-sm text-primary ${multiline ? '' : 'whitespace-nowrap'}`}>{text}</pre>
      <Button
        size="sm"
        variant="outline"
        aria-label={copied ? 'Copied' : label}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          } catch {
            toast('Couldn’t copy — select the text and copy it instead')
          }
        }}
      >
        {copied ? <Check size={13} strokeWidth={2} aria-hidden /> : <Copy size={13} strokeWidth={1.75} aria-hidden />}
      </Button>
    </div>
  )
}
