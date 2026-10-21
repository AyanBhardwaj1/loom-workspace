import { useQuery } from '@tanstack/react-query'
import { ChevronDown, LogOut, Search, Settings } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink } from 'react-router-dom'
import type { ProjectSummary, PresenceUser } from '@loom/shared'
import { api } from '../lib/api'
import { useAuth } from '../state/auth'
import { AiSettingsDialog } from './AiSettingsDialog'
import { NotificationBell } from './NotificationBell'
import { Avatar, IconButton, cn } from './primitives'
import { Popover, PopoverContent, PopoverTrigger } from './overlay'
import { Wordmark } from './Wordmark'

/** Fire the ⌘K palette from anywhere (the palette itself subscribes). */
export function openPalette(): void {
  window.dispatchEvent(new CustomEvent('loom:palette'))
}

/**
 * The 48px top bar — app chrome directly on the canvas (no fill), hairline
 * bottom border. Wordmark · project switcher · section nav ······ ⌘K ·
 * presence · settings · account.
 */
export function TopBar({
  projectId,
  projectName,
  presence = [],
  children,
}: {
  projectId?: string
  projectName?: string
  presence?: PresenceUser[]
  children?: ReactNode
}) {
  const { user, logout } = useAuth()
  // you are always online to yourself — the stack shows teammates
  const others = presence.filter((p) => p.userId !== user?.id)
  const [aiOpen, setAiOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)

  // the palette (and anything else) can open provider settings from anywhere
  useEffect(() => {
    const onOpen = () => setAiOpen(true)
    window.addEventListener('loom:settings', onOpen)
    return () => window.removeEventListener('loom:settings', onOpen)
  }, [])

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectSummary[] }>('/api/projects'),
    enabled: switcherOpen,
  })

  return (
    <header className="z-sticky flex h-12 shrink-0 items-center gap-2 border-b border-hairline px-3 sm:gap-3 sm:px-4">
      <Link to="/" className="flex shrink-0 items-center text-primary transition-colors duration-micro hover:text-lav-300" aria-label="All projects">
        <Wordmark height={18} />
      </Link>

      {projectName && (
        <>
          <span className="text-tertiary" aria-hidden>
            /
          </span>
          <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <PopoverTrigger asChild>
              <button className="flex min-w-0 items-center gap-1 rounded px-1.5 py-1 text-ui font-medium text-primary transition-colors duration-micro hover:bg-raised">
                <span className="max-w-[9rem] truncate sm:max-w-[14rem]">{projectName}</span>
                <ChevronDown size={14} strokeWidth={1.5} className="shrink-0 text-tertiary" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1.5">
              {/* phones: the section nav lives here instead of the bar */}
              <div className="mb-1 border-b border-hairline pb-1 sm:hidden">
                {[
                  { to: `/p/${projectId}`, label: 'Dashboard' },
                  { to: `/p/${projectId}/history`, label: 'History' },
                ].map((l) => (
                  <Link
                    key={l.to}
                    to={l.to}
                    onClick={() => setSwitcherOpen(false)}
                    className="flex w-full items-center rounded px-2 py-2 text-ui text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
                  >
                    {l.label}
                  </Link>
                ))}
              </div>
              <div className="px-2 pb-1.5 pt-1 text-small font-medium text-tertiary">Projects</div>
              {(projectsQuery.data?.projects ?? []).map((p) => (
                <Link
                  key={p.id}
                  to={`/p/${p.id}`}
                  aria-current={p.id === projectId ? 'page' : undefined}
                  onClick={() => setSwitcherOpen(false)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ui transition-colors duration-micro hover:bg-raised',
                    p.id === projectId ? 'text-primary' : 'text-secondary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.activeSessionCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-lav-500" aria-hidden />}
                </Link>
              ))}
            </PopoverContent>
          </Popover>

          <nav aria-label="Project" className="ml-1 hidden items-center gap-0.5 sm:flex">
            <BarLink to={`/p/${projectId}`} end>
              Dashboard
            </BarLink>
            <BarLink to={`/p/${projectId}/history`}>History</BarLink>
          </nav>
        </>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        {children}
        <button
          onClick={openPalette}
          className="hidden h-7 items-center gap-2 rounded border border-hairline px-2.5 text-small text-tertiary transition-colors duration-micro hover:border-hairline-hover hover:text-secondary md:flex"
        >
          <Search size={14} strokeWidth={1.5} aria-hidden />
          <span>Search or jump to…</span>
          <kbd>⌘&nbsp;K</kbd>
        </button>
        <IconButton label="Search or jump to" onClick={openPalette} className="md:hidden">
          <Search size={16} strokeWidth={1.5} aria-hidden />
        </IconButton>

        {others.length > 0 && (
          <div role="group" className="hidden items-center -space-x-1.5 sm:flex" aria-label={`${others.length} teammate${others.length === 1 ? '' : 's'} online`}>
            {others.slice(0, 4).map((p) => (
              <span key={p.userId} className="rounded-full ring-1 ring-canvas">
                <Avatar name={p.name} color={p.avatarColor} size="sm" title={`${p.name} is online`} />
              </span>
            ))}
          </div>
        )}

        <NotificationBell />

        <IconButton label="AI provider settings" onClick={() => setAiOpen(true)}>
          <Settings size={16} strokeWidth={1.5} aria-hidden />
        </IconButton>

        {user && (
          <Popover open={accountOpen} onOpenChange={setAccountOpen}>
            <PopoverTrigger asChild>
              <button
                aria-label={`Account: ${user.name}`}
                className="rounded-full transition-opacity duration-micro hover:opacity-80"
              >
                <Avatar name={user.name} color={user.avatarColor} size="md" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 p-1.5">
              <div className="flex items-center gap-2.5 px-2 pb-2 pt-1">
                <Avatar name={user.name} color={user.avatarColor} size="lg" />
                <div className="min-w-0">
                  <div className="truncate text-ui font-medium text-primary">{user.name}</div>
                  <div className="truncate font-mono text-small text-tertiary" translate="no">
                    {user.email}
                  </div>
                </div>
              </div>
              <div className="my-1 border-t border-hairline" />
              <button
                onClick={() => {
                  setAccountOpen(false)
                  setAiOpen(true)
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded px-2 text-left text-ui text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
              >
                <Settings size={14} strokeWidth={1.5} aria-hidden />
                AI provider &amp; effort
              </button>
              <button
                onClick={() => void logout()}
                className="flex h-9 w-full items-center gap-2.5 rounded px-2 text-left text-ui text-secondary transition-colors duration-micro hover:bg-raised hover:text-primary"
              >
                <LogOut size={14} strokeWidth={1.5} aria-hidden />
                Sign out
              </button>
            </PopoverContent>
          </Popover>
        )}
      </div>

      <AiSettingsDialog open={aiOpen} onClose={() => setAiOpen(false)} />
    </header>
  )
}

function BarLink({ to, end, children }: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'rounded px-2.5 py-1 text-ui transition-colors duration-micro',
          isActive ? 'bg-lav-fill text-lav-300' : 'text-secondary hover:bg-raised hover:text-primary',
        )
      }
    >
      {children}
    </NavLink>
  )
}
