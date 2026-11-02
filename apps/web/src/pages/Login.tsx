import { useState } from 'react'
import { BRAND } from '@loom/shared'
import { Avatar, Button, SectionLabel, cn } from '../components/primitives'
import { Wordmark } from '../components/Wordmark'
import { useAuth } from '../state/auth'

const POINTS = [
  { title: 'Watch it work', body: 'Every prompt, thought, edit and commit streams to the whole team as it happens.' },
  { title: 'Test it together', body: 'See each other’s cursors, clicks and errors in the live product — and follow anyone’s screen.' },
  { title: 'Fork any moment', body: 'Branch from any point in a session and keep going without touching the original.' },
  { title: 'Checks on every commit', body: 'The agent tests its own work like a user would. Everyone sees pass or fail.' },
]

/**
 * The front door: what Loom is on the left, the way in on the right. On
 * phones the statement collapses to one line above the form.
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
      setError(err instanceof Error ? err.message : 'Sign-in failed. Check the email and password, then try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main id="main" className="min-h-full overflow-y-auto">
      <div className="mx-auto grid min-h-full w-full max-w-[1280px] gap-10 px-4 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-14 lg:py-12">
        <section aria-labelledby="login-title" className="flex flex-col">
          <div className="flex items-center justify-between border-b-2 border-hairline-strong pb-3">
            <Wordmark height={26} className="text-primary" title={BRAND} />
            <span className="telemetry text-tertiary">Multiplayer AI development</span>
          </div>
          <h1 id="login-title" className="font-display mt-8 text-balance text-[clamp(2.75rem,7vw,6.5rem)] leading-[0.88] text-primary">
            Build with an AI agent. <span className="text-signal-500">Together.</span> Live.
          </h1>
          <p className="mt-6 max-w-[52ch] text-body text-secondary">
            One person drives the agent. The whole team watches it think, tests what it builds, suggests the next step, and forks to
            try their own idea.
          </p>
          <ol className="mt-10 hidden grid-cols-2 border-l border-t border-hairline-strong lg:grid">
            {POINTS.map(({ title, body }, i) => (
              <li key={title} className="border-b border-r border-hairline-strong p-4">
                <span className="tnum telemetry text-signal-300">{String(i + 1).padStart(2, '0')}</span>
                <span className="mt-2 block text-h4 text-primary">{title}</span>
                <span className="mt-1 block max-w-[40ch] text-ui text-secondary">{body}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="self-start border-2 border-hairline-strong bg-surface lg:mt-[3.25rem]">
          {devMode && devUsers.length > 0 && (
            <div className="p-2">
              <SectionLabel as="h2" className="px-2 pb-1.5 pt-1">
                Continue as
              </SectionLabel>
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
                        setError(err instanceof Error ? err.message : 'Login failed. Try again.')
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
                    <span className="ml-auto truncate font-mono text-small text-tertiary" translate="no">
                      {devBusy === u.id ? 'Signing in…' : u.email}
                    </span>
                  </button>
                ))}
              </div>
              <p className="px-2 pb-1 pt-2 text-small text-tertiary">Dev logins — no password. Real accounts use the form below.</p>
            </div>
          )}

          <form onSubmit={submit} className={cn('space-y-3 p-4', devMode && 'border-t border-hairline')} noValidate={false}>
            <SectionLabel as="h2">{mode === 'login' ? 'Sign in with email' : 'Create an account'}</SectionLabel>
            {mode === 'signup' && (
              <Field label="Your name">
                <input
                  className="loom-input"
                  name="name"
                  autoComplete="name"
                  placeholder="e.g. Priya Raman…"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
            )}
            <Field label="Email">
              <input
                className="loom-input"
                type="email"
                name="email"
                autoComplete="email"
                spellCheck={false}
                inputMode="email"
                placeholder="you@company.com…"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            <Field label="Password" hint={mode === 'signup' ? '8 characters or more' : undefined}>
              <input
                className="loom-input"
                type="password"
                name="password"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={mode === 'signup' ? 8 : undefined}
                required
              />
            </Field>
            {error && (
              <div role="alert" className="rounded border border-danger-border bg-danger-fill px-3 py-2 text-small text-danger">
                {error}
              </div>
            )}
            <Button type="submit" variant="primary" size="lg" disabled={busy} className="w-full">
              {busy ? 'One moment…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </Button>
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'signup' : 'login')
                setError(null)
              }}
              className="w-full rounded py-1 text-center text-small text-secondary transition-colors duration-micro hover:text-primary"
            >
              {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
            </button>
          </form>
        </div>
      </div>
    </main>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-small font-medium text-secondary">
        {label}
        {hint && <span className="font-normal text-tertiary">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
