import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { formatCost, formatTokens, type ContributionRow, type ProjectLedger, type SpendRow } from '@loom/shared'
import { Avatar, Button, CardSkeleton, EmptyState, ErrorState, PageHeader, SectionLabel } from '../components/primitives'
import { api } from '../lib/api'
import { downloadMarkdown } from '../lib/exportMarkdown'
import { useProject } from './ProjectShell'

/**
 * The ledger: what the agent cost, attributed to whoever was driving (by
 * member, module and session), and what every person contributed — prompts,
 * steers, suggestions, test verdicts, approvals, comments, forks, merges.
 * Straight from the event log, so it's the same record replay shows.
 */
export function LedgerPage() {
  const { projectId, detailQuery } = useProject()
  const q = useQuery({
    queryKey: ['ledger', projectId],
    queryFn: () => api.get<ProjectLedger>(`/api/projects/${projectId}/ledger`),
    refetchInterval: 30_000,
  })
  const ledger = q.data
  const projectName = detailQuery.data?.name ?? 'Project'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-8">
        <PageHeader
          title="Ledger"
          meta={ledger ? `${formatCost(ledger.totalUsd)} · ${formatTokens(ledger.totalTokens)} tokens · ${ledger.contributions.length} contributor${ledger.contributions.length === 1 ? '' : 's'}` : 'Spend and contributions'}
          actions={
            ledger && ledger.contributions.length > 0 ? (
              <Button variant="outline" onClick={() => downloadMarkdown(`${projectName.replace(/[^\w.-]+/g, '-')}-contributions.md`, toMarkdown(projectName, ledger))}>
                <Download size={14} strokeWidth={1.75} aria-hidden /> Contribution report
              </Button>
            ) : undefined
          }
        />

        {q.isLoading ? (
          <div className="mt-8 grid gap-6 lg:grid-cols-2">
            <CardSkeleton lines={4} />
            <CardSkeleton lines={4} />
          </div>
        ) : q.isError || !ledger ? (
          <div className="mt-8">
            <ErrorState message="Couldn’t load the ledger. Check the server, then try again." onRetry={() => void q.refetch()} />
          </div>
        ) : ledger.contributions.length === 0 && ledger.byMember.length === 0 ? (
          <EmptyState className="mt-8 border border-hairline-strong" title="Nothing recorded yet." hint="Spend and contributions appear here as soon as someone drives a session." />
        ) : (
          <>
            <div className="mt-8 grid gap-8 lg:grid-cols-3">
              <SpendList title="Spend by person" hint="Attributed to whoever was driving — handoffs move the meter." rows={ledger.byMember} withAvatar />
              <SpendList title="Spend by module" rows={ledger.byModule} />
              <SpendList title="Costliest sessions" rows={ledger.bySession} />
            </div>

            <SectionLabel className="mt-12">Contributions</SectionLabel>
            <p className="mt-2 max-w-[70ch] text-small text-tertiary">
              Everything here is counted from the session logs — the record instructors and leads usually rebuild by hand.
            </p>
            <div className="mt-4 overflow-x-auto border border-hairline-strong bg-surface">
              <table className="w-full min-w-[760px] text-left">
                <caption className="sr-only">Contributions per person</caption>
                <thead>
                  <tr className="border-b border-hairline-strong">
                    {['Person', 'Prompts', 'Steers', 'Suggestions', 'Verdicts', 'Approvals', 'Comments', 'Forks', 'Merges'].map((h, i) => (
                      <th key={h} scope="col" className={`telemetry px-3 py-2 font-normal text-tertiary ${i > 0 ? 'text-right' : ''}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ledger.contributions.map((c) => (
                    <tr key={c.userId} className="border-b border-hairline last:border-b-0">
                      <th scope="row" className="px-3 py-2 font-normal">
                        <span className="inline-flex items-center gap-2 text-ui font-semibold text-primary">
                          <Avatar name={c.name} color={c.avatarColor} size="sm" />
                          {c.name}
                        </span>
                      </th>
                      <Num v={c.prompts} />
                      <Num v={c.steers} />
                      <Num v={c.suggestions} sub={c.suggestions > 0 ? `${c.suggestionsAccepted} accepted` : undefined} />
                      <Num v={c.verdicts} sub={c.failsCaught > 0 ? `${c.failsCaught} caught a failure` : undefined} />
                      <Num v={c.approvals} />
                      <Num v={c.comments} />
                      <Num v={c.forks} />
                      <Num v={c.merges} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Num({ v, sub }: { v: number; sub?: string }) {
  return (
    <td className="tnum px-3 py-2 text-right align-top font-mono text-code-sm text-primary">
      {v === 0 ? <span className="text-tertiary">—</span> : v}
      {sub && <div className="font-sans text-micro normal-case tracking-normal text-tertiary">{sub}</div>}
    </td>
  )
}

/** one measure per entity: a ranked single-hue bar list, values printed as text */
function SpendList({ title, hint, rows, withAvatar = false }: { title: string; hint?: string; rows: SpendRow[]; withAvatar?: boolean }) {
  const max = Math.max(...rows.map((r) => r.costUsd || r.tokens), 0) || 1
  const byCost = rows.some((r) => r.costUsd > 0)
  return (
    <section aria-label={title}>
      <SectionLabel as="h2">{title}</SectionLabel>
      {hint && <p className="mt-2 text-small text-tertiary">{hint}</p>}
      {rows.length === 0 ? (
        <p className="mt-3 text-small text-tertiary">No spend yet.</p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {rows.map((r) => {
            const value = byCost ? r.costUsd : r.tokens
            const label = `${r.label}: ${formatCost(r.costUsd)}, ${formatTokens(r.tokens)} tokens over ${r.turns} turn${r.turns === 1 ? '' : 's'}`
            return (
              <li key={r.key} title={label}>
                <div className="flex items-baseline gap-2 text-small">
                  {withAvatar && <Avatar name={r.label} color={r.color ?? '#C9C3B5'} size="xs" />}
                  <span className="min-w-0 flex-1 truncate text-primary">{r.label}</span>
                  <span className="tnum shrink-0 font-mono text-code-sm text-primary">{formatCost(r.costUsd)}</span>
                  <span className="tnum w-16 shrink-0 text-right font-mono text-code-sm text-tertiary">{formatTokens(r.tokens)}</span>
                </div>
                <div aria-hidden className="mt-1 h-2 bg-inset">
                  <div className="h-full bg-primary" style={{ width: `${Math.max(2, (value / max) * 100)}%` }} />
                </div>
                <span className="sr-only">{label}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

function toMarkdown(project: string, l: ProjectLedger): string {
  const row = (c: ContributionRow) =>
    `| ${c.name} | ${c.prompts} | ${c.steers} | ${c.suggestions} (${c.suggestionsAccepted} accepted) | ${c.verdicts} (${c.failsCaught} failures caught) | ${c.approvals} | ${c.comments} | ${c.forks} | ${c.merges} |`
  return [
    `# ${project} — contribution report`,
    '',
    `Generated ${new Date().toLocaleString()} from the Loom session logs.`,
    '',
    '| Person | Prompts | Steers | Suggestions | Test verdicts | Approvals | Comments | Forks | Merges |',
    '|---|---|---|---|---|---|---|---|---|',
    ...l.contributions.map(row),
    '',
    `## Spend — ${formatCost(l.totalUsd)}, ${formatTokens(l.totalTokens)} tokens`,
    '',
    ...l.byMember.map((r) => `- ${r.label}: ${formatCost(r.costUsd)} (${formatTokens(r.tokens)} tokens, ${r.turns} turns)`),
    '',
    '## Reflection',
    '',
    '_Each contributor: what did you decide, what did you verify, and what would you do differently?_',
    '',
  ].join('\n')
}
