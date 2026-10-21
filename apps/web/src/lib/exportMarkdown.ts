import type { SessionDetail, SessionEvent } from '@loom/shared'

/**
 * F12 — export the session as a single self-contained Markdown file:
 * title, digest, transcript with speakers and timestamps, tool calls and
 * diffs as fenced blocks, commits with Simple + Technical lines.
 */
export function sessionToMarkdown(detail: SessionDetail, events: SessionEvent[]): string {
  const s = detail.session
  const lines: string[] = []
  lines.push(`# ${s.title}`)
  lines.push('')
  lines.push(`Module: ${detail.moduleName} · Driver: ${s.driverName} · Branch: \`${s.branchName}\``)
  lines.push('')

  if (detail.digest) {
    lines.push('## Digest')
    lines.push('')
    for (const b of detail.digest.bullets) lines.push(`- ${b}`)
    lines.push('')
    lines.push(
      `${detail.digest.commitCount} commit${detail.digest.commitCount === 1 ? '' : 's'} · files: ${detail.digest.files.map((f) => `\`${f}\``).join(', ') || '—'}`,
    )
    lines.push('')
  }

  lines.push('## Transcript')
  lines.push('')
  for (const e of events) {
    const at = new Date(e.createdAt).toISOString().slice(11, 19)
    switch (e.type) {
      case 'user_message':
        lines.push(`**${s.driverName}** (${at}):`)
        lines.push('')
        lines.push(e.payload.text)
        lines.push('')
        break
      case 'assistant_message':
        lines.push(`**Agent** (${at}):`)
        lines.push('')
        lines.push(e.payload.text)
        lines.push('')
        break
      case 'thought':
        lines.push(...e.payload.text.trim().split('\n').map((l) => `> _${l || ' '}_`))
        lines.push('')
        break
      case 'tool_call':
        lines.push('```tool')
        lines.push(`${e.payload.toolName}(${JSON.stringify(e.payload.input)})`)
        lines.push('```')
        lines.push('')
        break
      case 'tool_result':
        lines.push(`> ${e.payload.ok ? '✓' : '✗'} ${e.payload.summary}`)
        lines.push('')
        break
      case 'file_change':
        lines.push(`**${e.payload.changeKind}** \`${e.payload.path}\` (+${e.payload.additions} −${e.payload.deletions})`)
        lines.push('')
        lines.push('```diff')
        lines.push(e.payload.unifiedDiff.trimEnd())
        lines.push('```')
        lines.push('')
        break
      case 'commit':
        lines.push(`### Commit \`${e.payload.commitSha.slice(0, 7)}\` (${at})`)
        lines.push('')
        lines.push(e.payload.plainExplanation)
        lines.push('')
        lines.push(`> ${e.payload.technicalSummary}`)
        lines.push('')
        break
      case 'suggestion':
        lines.push(`> 💡 ${e.payload.suggesterName} suggested: ${e.payload.text}`)
        lines.push('')
        break
      case 'annotation':
        lines.push(
          `> ${e.payload.authorName} ${e.payload.kind === 'comment' ? `commented: ${e.payload.body}` : `reacted (${e.payload.body})`}`,
        )
        lines.push('')
        break
      case 'status':
        if (e.payload.note) {
          lines.push(`*${e.payload.note}* (${at})`)
          lines.push('')
        }
        break
      case 'fork_marker':
        lines.push(`*${e.payload.byUserName} forked from here*`)
        lines.push('')
        break
      default:
        break
    }
  }
  return lines.join('\n')
}

export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
