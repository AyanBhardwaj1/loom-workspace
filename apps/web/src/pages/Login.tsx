import { useState } from 'react'
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
    <div className="flex min-h-full items-center justify-center bg-[radial-gradient(1000px_500px_at_50%_-10%,#1d1a33_0%,#0a0a0f_60%)] p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="text-4xl">🧵</div>
          <h1 className="mt-3 text-3xl font-bold tracking-tight">Loom</h1>
          <p className="mt-1.5 text-sm text-ink-300">
            Multiplayer AI development — watch, fork, and build together.
          </p>
        </div>

        {devMode && devUsers.length > 0 && (
          <div className="card mb-4 p-5">
            <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-300">
              Quick login <span className="ml-1 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] normal-case">dev</span>
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
                  className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-left transition-colors hover:border-accent disabled:opacity-50"
                >
                  <Avatar name={u.name} color={u.avatarColor} size="sm" />
                  <span className="text-sm">{u.name}</span>
                  <span className="ml-auto text-xs text-ink-400">{devBusy === u.id ? 'signing in…' : u.email}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <form onSubmit={submit} className="card space-y-3 p-5">
          <div className="text-xs font-semibold uppercase tracking-wider text-ink-300">
            {mode === 'login' ? 'Sign in with email' : 'Create an account'}
          </div>
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
