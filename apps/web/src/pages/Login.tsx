import { useState } from 'react'
import { BRAND, BRAND_TAGLINE } from '@loom/shared'
import { Avatar } from '../components/ui'
import { useAuth } from '../state/auth'

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
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden p-6">
      {/* cinematic ambient glow behind everything */}
      <div
        className="pointer-events-none absolute left-1/2 top-[-10%] h-[60vh] w-[60vh] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(139,124,246,0.22), rgba(56,214,224,0.06) 55%, transparent 70%)' }}
      />
      <div className="anim-dialog-in relative w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center text-4xl">
            <span className="animate-breathe drop-shadow-[0_0_16px_rgba(139,124,246,0.55)]">🧵</span>
          </div>
          <h1 className="mt-2 bg-gradient-to-b from-white to-ink-300 bg-clip-text text-4xl font-bold tracking-tight text-transparent">
            {BRAND}
          </h1>
          <div className="mx-auto mt-2 h-px w-28 origin-center animate-[login-thread_0.7s_ease-out_both]"
            style={{ background: 'linear-gradient(90deg, transparent, #8b7cf6, #38d6e0, transparent)' }}
          />
          <p className="mt-3 text-sm text-ink-300">{BRAND_TAGLINE} — watch, fork, and build together.</p>
        </div>

        {devMode && devUsers.length > 0 && (
          <div className="panel mb-4 p-5">
            <div className="hairline absolute inset-x-5 top-0" />
            <div className="mb-3 flex items-center gap-2">
              <span className="micro-label">quick login</span>
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] uppercase text-ink-400">dev</span>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              {devUsers.map((u) => (
                <button
                  key={u.id}
                  disabled={devBusy !== null}
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
                  data-testid={`quick-login-${u.email}`}
                  className="group flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-left transition-all duration-150 hover:-translate-y-px hover:border-white/20 hover:bg-white/[0.05] disabled:opacity-50"
                >
                  <span className="transition-transform duration-150 group-hover:scale-110" style={{ filter: `drop-shadow(0 0 8px ${u.avatarColor}88)` }}>
                    <Avatar name={u.name} color={u.avatarColor} size="sm" />
                  </span>
                  <span className="text-sm font-medium">{u.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-400">
                    {devBusy === u.id ? 'signing in…' : u.email}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={submit} className="panel space-y-3 p-5">
          <div className="micro-label">{mode === 'login' ? 'sign in with email' : 'create an account'}</div>
          {mode === 'signup' && (
            <input
              className="input"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <input
            className="input"
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="input"
            type="password"
            placeholder={mode === 'signup' ? 'Password (8+ characters)' : 'Password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'signup' ? 8 : undefined}
            required
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login')
              setError(null)
            }}
            className="w-full text-center text-xs text-ink-400 hover:text-accent"
          >
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}
