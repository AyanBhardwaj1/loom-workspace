import type { FileDiff } from '../git/gitService'

export interface SummaryInput {
  projectName: string
  moduleName: string
  driverName: string
  userMessage: string
  diffs: FileDiff[]
}

export interface CommitSummary {
  technicalSummary: string
  plainExplanation: string
}

export interface Summarizer {
  summarize(input: SummaryInput): Promise<CommitSummary>
}

/**
 * Deterministic, template-based summaries for mock mode (and the fallback
 * when a real model call fails). Written to read well to a non-technical
 * founder: the plain explanation never assumes the reader knows git.
 */
export class TemplateSummarizer implements Summarizer {
  async summarize(input: SummaryInput): Promise<CommitSummary> {
    const { diffs } = input
    const additions = diffs.reduce((n, d) => n + d.additions, 0)
    const deletions = diffs.reduce((n, d) => n + d.deletions, 0)
    const created = diffs.filter((d) => d.changeKind === 'create').map((d) => d.path)
    const edited = diffs.filter((d) => d.changeKind === 'edit').map((d) => d.path)
    const deleted = diffs.filter((d) => d.changeKind === 'delete').map((d) => d.path)

    const parts: string[] = []
    if (created.length) parts.push(`add ${created.join(', ')}`)
    if (edited.length) parts.push(`update ${edited.join(', ')}`)
    if (deleted.length) parts.push(`remove ${deleted.join(', ')}`)
    const technicalSummary = `${capitalize(parts.join('; ') || 'update files')} (+${additions}/−${deletions})`

    const what = trimAsk(input.userMessage)
    const fileDescription = describeFiles(created, edited, deleted)
    const plainExplanation = `${input.driverName} asked the agent to ${what}. It ${fileDescription} in the ${input.moduleName} area of ${input.projectName}.`

    return { technicalSummary, plainExplanation }
  }
}

export function describeFiles(created: string[], edited: string[], deleted: string[]): string {
  const bits: string[] = []
  if (created.length) bits.push(`created ${listOf(created)}`)
  if (edited.length) bits.push(`updated ${listOf(edited)}`)
  if (deleted.length) bits.push(`removed ${listOf(deleted)}`)
  return bits.join(' and ') || 'made changes'
}

function listOf(paths: string[]): string {
  if (paths.length <= 2) return paths.join(' and ')
  return `${paths.slice(0, 2).join(', ')} and ${paths.length - 2} more file${paths.length - 2 === 1 ? '' : 's'}`
}

function trimAsk(msg: string): string {
  let s = msg.trim().replace(/\s+/g, ' ')
  // drop trailing punctuation, lowercase the lead-in so it flows after "to"
  s = s.replace(/[.!?]+$/, '')
  if (s.length > 90) s = s.slice(0, 89) + '…'
  return `“${s}”`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
