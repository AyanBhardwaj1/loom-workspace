import { useState } from 'react'
import { Eye, GitFork, History } from 'lucide-react'
import { BRAND } from '@loom/shared'
import { Avatar, Button, SectionLabel, cn } from '../components/primitives'
import { Wordmark } from '../components/Wordmark'
import { useAuth } from '../state/auth'

const POINTS = [
  { icon: Eye, title: 'Watch it work', body: 'Every prompt, thought, edit and commit streams to your whole team as it happens.' },
  { icon: GitFork, title: 'Fork any moment', body: 'Branch from any point in a session and keep going without touching the original.' },
  { icon: History, title: 'History in plain English', body: 'Each commit is explained for humans, then merged into main with one click.' },
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
      <div className="mx-auto grid min-h-full w-full max-w-5xl items-center gap-10 px-4 py-10 sm:px-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-16">
        <section aria-labelledby="login-title">
          <Wordmark height={30} className="text-primary" title={BRAND} />
          <h1 id="login-title" className="mt-6 text-balance text-display text-primary lg:text-[32px] lg:leading-[40px]">
            Build software with an AI agent — together, live.
          </h1>
          <p className="mt-3 max-w-[52ch] text-body text-secondary">
            One person drives the agent. The whole team watches it think, suggests the next step, and forks to try their own
            idea.
          </p>
          <ul className="mt-8 hidden space-y-5 lg:block">
            {POINTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-hairline bg-surface text-lav-300">
                  <Icon size={14} strokeWidth={1.5} aria-hidden />
                </span>
                <span>
                  <span className="block text-ui font-medium text-primary">{title}</span>
                  <span className="block max-w-[46ch] text-ui text-tertiary">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <div className="rounded-lg border border-hairline bg-surface">
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
                placeholder="you@company.com"
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
