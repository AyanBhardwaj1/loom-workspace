import { useState } from 'react'
import { BRAND } from '@loom/shared'
import { Avatar, Button, cn } from '../components/primitives'
import { Wordmark } from '../components/Wordmark'
import { useAuth } from '../state/auth'

/**
 * VII.2 — the one screen where the living canvas breathes around negative
 * space. A single 400px surface card: wordmark at display scale, one honest
 * line, the five founders as 44px rows, then the email form. No hero art.
 */
export function Login() {
  const { login, signup, devLogin, devMode, devUsers } = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [devBusy, setDevBusy] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await signup(name, email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Check the email and password.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <Wordmark height={34} className="text-primary" title={BRAND} />
          <p className="mt-3 text-ui text-secondary">Multiplayer AI coding sessions.</p>
        </div>

        <div className="rounded-lg border border-hairline bg-surface">
          {devMode && devUsers.length > 0 && (
            <div className="p-2">
              <div className="px-2 pb-1.5 pt-1 text-micro uppercase tracking-[0.08em] text-tertiary">
                Continue as
              </div>
              <div>
                {devUsers.map((u, i) => (
                  <button
                    key={u.id}
                    disabled={devBusy !== null}
                    data-testid={`quick-login-${u.email}`}
                    onClick={async () => {
                      setDevBusy(u.id)
                      setError(null)
                      try {
                        await devLogin(u.id)
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Login failed')
                        setDevBusy(null)
                      }
                    }}
                    className={cn(
                      'flex h-11 w-full items-center gap-3 rounded px-2.5 text-left transition-colors duration-micro hover:bg-raised disabled:opacity-50',
                      i > 0 && 'border-t border-hairline',
                    )}
                  >
                    <Avatar name={u.name} color={u.avatarColor} size="md" />
                    <span className="text-ui font-medium text-primary">{u.name}</span>
                    <span className="ml-auto font-mono text-small text-tertiary">
                      {devBusy === u.id ? 'signing in…' : u.email}
                    </span>
                  </button>
                ))}
              </div>
              <p className="px-2 pb-1 pt-2 text-small text-tertiary">
                Dev logins — no password. Real accounts use the form below.
              </p>
            </div>
          )}

          <form onSubmit={submit} className={cn('space-y-2.5 p-4', devMode && 'border-t border-hairline')}>
            <div className="text-micro uppercase tracking-[0.08em] text-tertiary">
              {mode === 'login' ? 'Sign in with email' : 'Create an account'}
            </div>
            {mode === 'signup' && (
              <input
                className="loom-input"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
            <input
              className="loom-input"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="loom-input"
              type="password"
              placeholder={mode === 'signup' ? 'Password (8+ characters)' : 'Password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={mode === 'signup' ? 8 : undefined}
              required
            />
            {error && <div className="text-small text-danger">{error}</div>}
            <Button type="submit" variant="primary" disabled={busy} className="w-full">
              {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login')
                setError(null)
              }}
              className="w-full text-center text-small text-tertiary transition-colors duration-micro hover:text-secondary"
            >
              {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
