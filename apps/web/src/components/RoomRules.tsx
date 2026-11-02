import { Lock, LockOpen } from 'lucide-react'
import { useId, useState } from 'react'
import { toast } from 'sonner'
import type { GateMode } from '@loom/shared'
import { usePolicy } from '../state/usePolicy'
import { Button, SegmentedControl } from './primitives'

const GATE_COPY: Record<GateMode, string> = {
  enforce: 'Work reaches main only after checks pass, a teammate verifies it, and someone other than the driver merges.',
  warn: 'Unverified work can still merge — history marks it as unverified.',
  off: 'No merge gate.',
}

/**
 * The room's rules, in one place: the merge gate and guarded actions (set by
 * the owner) and the freeze — a brake any member can pull. These are enforced
 * by the server at the merge route and the tool call, never by a prompt.
 */
export function RoomRules({ projectId }: { projectId: string }) {
  const { policy, isOwner, update } = usePolicy(projectId)
  const [paths, setPaths] = useState<string | null>(null)
  const pathsId = useId()
  if (!policy) return null
  const save = async (patch: Parameters<typeof update>[0], done?: string) => {
    try {
      await update(patch)
      if (done) toast(done)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save')
    }
  }
  return (
    <section aria-label="Room rules" className="border-b border-hairline-strong px-4 py-4">
      <div className="flex items-center justify-between">
        <h2 className="telemetry text-primary">Room rules</h2>
        {!isOwner && <span className="telemetry text-tertiary">Set by the owner</span>}
      </div>

      <div className="mt-3">
        <div className="text-small font-semibold text-primary">Merge gate</div>
        {isOwner ? (
          <SegmentedControl
            size="sm"
            className="mt-1.5 w-full"
            ariaLabel="Merge gate"
            value={policy.mergeGate}
            onChange={(v) => void save({ mergeGate: v as GateMode })}
            options={[
              { value: 'enforce', label: 'Enforce' },
              { value: 'warn', label: 'Warn' },
              { value: 'off', label: 'Off' },
            ]}
          />
        ) : (
          <div className="telemetry mt-1 text-secondary">{policy.mergeGate}</div>
        )}
        <p className="mt-1.5 text-small text-tertiary">{GATE_COPY[policy.mergeGate]}</p>
      </div>

      <label className="mt-3 flex items-start gap-2">
        <input
          type="checkbox"
          name="guarded-actions"
          checked={policy.guardedActions}
          disabled={!isOwner}
          onChange={(e) => void save({ guardedActions: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--text-primary)]"
        />
        <span>
          <span className="block text-small font-semibold text-primary">Guarded actions</span>
          <span className="block text-small text-tertiary">Deleting files, running commands and touching protected files waits for a teammate&rsquo;s approval.</span>
        </span>
      </label>

      {isOwner && policy.guardedActions && (
        <div className="mt-2">
          <label htmlFor={pathsId} className="telemetry text-tertiary">
            Protected files
          </label>
          <div className="mt-1 flex gap-1.5">
            <input
              id={pathsId}
              name="protected-paths"
              autoComplete="off"
              spellCheck={false}
              value={paths ?? policy.protectedPaths.join(', ')}
              onChange={(e) => setPaths(e.target.value)}
              className="loom-input py-1 font-mono text-code-sm"
            />
            {paths !== null && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void save({ protectedPaths: paths.split(',').map((p) => p.trim()).filter(Boolean) }, 'Protected files saved')
                  setPaths(null)
                }}
              >
                Save
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-hairline pt-3">
        {policy.frozen ? (
          <>
            <div className="telemetry text-signal-300">Frozen by {policy.frozenBy ?? 'a teammate'}</div>
            <p className="mt-1 text-small text-tertiary">The agent can&rsquo;t change files in any session until someone unfreezes.</p>
            <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => void save({ frozen: false }, 'Unfrozen — the agent can write again')}>
              <LockOpen size={13} strokeWidth={1.75} aria-hidden /> Unfreeze
            </Button>
          </>
        ) : (
          <>
            <p className="text-small text-tertiary">Demo or release coming up? Freeze stops every agent from changing files — enforced, not requested.</p>
            <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => void save({ frozen: true }, 'Frozen — agents can no longer change files')}>
              <Lock size={13} strokeWidth={1.75} aria-hidden /> Freeze the project
            </Button>
          </>
        )}
      </div>
    </section>
  )
}
