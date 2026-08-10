import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Search, Settings } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import type { ProjectSummary, PresenceUser } from '@loom/shared'
import { api } from '../lib/api'
import { useAuth } from '../state/auth'
import { AiSettingsDialog } from './AiSettingsDialog'
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
  const navigate = useNavigate()
  const [aiOpen, setAiOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<{ projects: ProjectSummary[] }>('/api/projects'),
    enabled: switcherOpen,
  })

  return (
    <header className="z-sticky flex h-12 shrink-0 items-center gap-3 border-b border-hairline px-4">
      <Link to="/" className="flex items-center text-primary transition-colors duration-micro hover:text-lav-300" aria-label="All projects">
        <Wordmark height={18} />
      </Link>

      {projectName && (
        <>
          <span className="text-tertiary">/</span>
          <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <PopoverTrigger asChild>
              <button className="flex items-center gap-1 rounded px-1.5 py-1 text-ui font-medium text-primary transition-colors duration-micro hover:bg-raised">
                {projectName}
                <ChevronDown size={14} strokeWidth={1.5} className="text-tertiary" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-1.5">
              <div className="px-2 pb-1.5 pt-1 text-micro uppercase tracking-[0.08em] text-tertiary">Projects</div>
              {(projectsQuery.data?.projects ?? []).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSwitcherOpen(false)
                    navigate(`/p/${p.id}`)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-ui transition-colors duration-micro hover:bg-raised',
                    p.id === projectId ? 'text-primary' : 'text-secondary',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.activeSessionCount > 0 && <span className="h-1.5 w-1.5 rounded-full bg-lav-500" aria-hidden />}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          <nav className="ml-1 flex items-center gap-0.5">
            <BarLink to={`/p/${projectId}`} end>
              Dashboard
            </BarLink>
            <BarLink to={`/p/${projectId}/history`}>History</BarLink>
          </nav>
        </>
      )}

      <div className="ml-auto flex items-center gap-2">
        {children}
        <button
          onClick={openPalette}
          className="hidden h-7 items-center gap-2 rounded border border-hairline px-2.5 text-small text-tertiary transition-colors duration-micro hover:border-hairline-hover hover:text-secondary md:flex"
        >
          <Search size={14} strokeWidth={1.5} />
          <span>Search or jump to…</span>
          <kbd>⌘K</kbd>
        </button>

        {presence.length > 0 && (
          <div className="flex items-center -space-x-1.5" title="Online now">
            {presence.slice(0, 4).map((p) => (
              <span key={p.userId} className="rounded-full ring-1 ring-canvas">
                <Avatar name={p.name} color={p.avatarColor} size="sm" title={`${p.name} is online`} />
              </span>
            ))}
          </div>
        )}

        <IconButton label="AI provider settings" onClick={() => setAiOpen(true)}>
          <Settings size={16} strokeWidth={1.5} />
        </IconButton>

        {user && (
          <button
            onClick={() => void logout()}
            title={`${user.name} — sign out`}
            className="rounded-full transition-opacity duration-micro hover:opacity-80"
          >
            <Avatar name={user.name} color={user.avatarColor} size="md" />
          </button>
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
