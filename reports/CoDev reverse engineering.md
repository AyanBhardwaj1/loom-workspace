# CoDev, reverse-engineered — and what Loom took from it

**Target:** https://www.trycodev.com (public beta, read 2026-11-02). **Method:** the public landing page and all 22 documentation pages, plus pricing, security and FAQ. The docs describe the product's mechanisms in enough detail that no bundle decompilation or traffic capture was needed. Nothing proprietary was copied: every Loom feature below was written fresh against Loom's own architecture.

## What CoDev is

A coordination layer that makes each teammate's *own* coding agent (Claude Code, Codex, Cursor, plus ChatGPT/Claude via connector) "multiplayer", with a cloud workspace (an ARM64 Linux VM per workspace) where agents can also run.

```
laptop agent ──hooks (after edits, turn start/end)──► codev CLI ──► coordination service (paths + function names only)
      │                                                    │
      └── WIP snapshot ──► hidden ref refs/codev/wip/… on the team's own origin (≤ every 30 s)
                                                           │
teammate's CLI ◄── fetch ref into scratch store, test-merge ┘ ──► "conflict in <function>: fix it now" to BOTH agents
```

## Observed (from the docs)

| Area | Mechanism |
|---|---|
| Connect | One "setup prompt" pasted into the agent installs the `codev` CLI, adds a `codev` plugin (Claude Code/Codex) with hooks, an editor extension (VS Code/Cursor), and the MCP connector at `/api/mcp` |
| Coordinate | Hook `codev coordinate <agent>` runs after edits and at turn start/end, answers from cached state, refreshes ≤ every 10 s; each agent hears once who else is working (member, agent, laptop/cloud, branch, a few files), again only when that changes; an agent alone gets nothing |
| Conflicts | WIP (incl. uncommitted + untracked) pushed to `refs/codev/wip/…` ≤ every 30 s; teammates' CLIs test-merge in a scratch store; conflicts are reported **by function** to both agents, "fix it now while it's small"; also vs the default branch (fetched ≤ every 5 min); clean merges aren't reported; the service sees paths/function names, never contents |
| Live main | Combined, runnable, read-only version of everyone's work, built in "live main's order"; per-worktree "In live main / Doesn't fit yet (file, functions, whose)"; checks on the combination; ship = commit, push and open a PR per member, in order; CoDev never merges PRs |
| Board | Lanes: Needs you · Agent working · To review · Idle · Merged; card status vs main: Up to date, Ready to merge, Behind main, Taking in main, Conflicts with main, Agent resolving, Fixed · tests pass/fail, Merged |
| Duplicates | A new task is compared with running tasks: "Open session" / "Start anyway" |
| Chats | Local agent chats mirrored live (opt-in, secrets redacted); teammates "Continue in this workspace" / "Continue on my computer"; `codev handoff` passes a session + WIP to a teammate |
| MCP tools | `codev_list_workspaces`, `codev_read_workspace_chat`, `codev_ask_workspace_agent`, `codev_read/write_workspace_file`, `codev_workspace_git`, `codev_run_command`, `codev_live_main`, `codev_mark_ready`, `codev_ship`, pages/skills/rooms tools |
| Cloud | One VM per workspace, 16 GiB disk, sleeps after 10 min idle, $0.01/min; per-worktree agents (never two in one checkout); shared terminals; previews on a separate domain |
| Business | $20 starter credits; PAYG / Pro $20 / Teams $20 per seat; CoDev AI = provider price + 30% |
| Security | GitHub token never enters the workspace (pushes from an isolated account on a throwaway copy); per-turn provider tokens; the page admits operators can technically reach data today and lists 6 planned hardening steps |

## Inferred (with confidence)

- **Function-level conflicts come from a test-merge plus a symbol map of the conflicting hunks** (high): the docs say "test-merges" and "which function conflicts"; nothing else would give function names without sending contents.
- **"Live main's order" is arrival order** (medium): "work that came first" stays, "the newer work adapts". The rule itself is never stated.
- **Governance is per-person, not per-room** (high): permission levels (Ask / Auto-accept / Bypass) are set by whoever runs the agent. No second person is required for a merge, a destructive action or verification. Viewers can only watch.

## Unknown

- Test-merge cadence beyond the stated caps, and how functions are identified per language.
- Live main's ordering rule and its "holds 16" cap. What "checks" run on live main.
- Whether coordination works for repos without a CoDev workspace beyond the documented default-branch check.

## Where Loom already went further

CoDev keeps agents from colliding. Loom also makes the *people* part of every decision:
- **Mid-run steering** at tool boundaries. CoDev only queues a message until the turn ends.
- **Co-testing the live preview** with shared cursors, follow mode and team-verified test cases.
- **A merge gate.** Verified by someone other than the driver, checks on the current version, separation of duties; overrides are written into history.
- **Guarded actions and freeze.** A second person approves deletes, shell commands and protected files.
- **Provenance trailers** on every merge, plus a ledger and replay.

## What Loom built from CoDev (this round)

| CoDev idea | Loom's version | Improvement |
|---|---|---|
| Agents keep each other posted | **Coordination radar** (`apps/server/src/coord/`): per active branch, files and **symbols** changed (JS/TS functions, methods and classes; CSS rules; HTML sections; Python defs) vs main, with uncommitted edits included. The agent is **briefed at turn start**. | Visible to humans: briefings and conflicts are rows in the session log and on the Board, not just agent context |
| Conflicts caught as written | After each write tool (throttled 4 s) a **test-merge** runs. A new conflict is told to the agent **inside the tool result**, so it adapts mid-turn, and is recorded in **both** sessions' logs. A later clean merge records **Resolved**, which counts as "conflicts caught before merge". | Content-level test-merge on the server, because the code is already there, so no hidden refs are needed |
| Live main | `GET /api/projects/:id/live-main`, preview at `/preview/live/:id`. Main plus everyone's work folded in by **arrival order** (first commit). Each entry is In / Doesn't fit yet, with the conflicting files and functions and **whose** work it collides with (symbol-precise blame). Checks run on the combination. | Combined preview is co-testable, and the merge gate still governs what reaches main |
| Board | `/p/:id/board`: five lanes, a state chip, branch vs main (Up to date, Ready to merge, Behind main, Conflicts with main), overlaps (conflict or merges cleanly), laptop agents, a conflicts-caught counter, and Live main. | Lanes come from Loom's derived session state. "Needs you" includes approvals and tests to try. |
| Duplicate task check | `POST /api/sessions/:id/similar`. The composer warns before a session's first task if a **teammate's** session matches: "Open their session" or "Start anyway". | Your own parallel sessions don't trigger it |
| MCP connector | `POST /api/mcp` (Streamable HTTP, JSON). **Personal agent tokens** are shown once and stored as hashes. Tools: `loom_list_projects`, `loom_announce` (names only, 20-min TTL), `loom_radar`, `loom_list_sessions`, `loom_read_session`, `loom_live_main`, `loom_read_file`, `loom_suggest`. "Connect your coding agent" dialog gives Claude Code and Cursor setup. | **Laptop agents can suggest but never steer**: a human driver decides, consistent with Loom's gates |

**Deliberately not copied:**
- Per-workspace cloud VMs, credits and billing.
- Rooms (shared chat with AIs asking each other).
- Chat mirroring of local sessions.
- `codev handoff` (Loom has "pass the wheel" and forks).
- Pushing WIP refs to the user's origin (Loom's code is already server-side).
- Shipping PRs to GitHub (Loom merges into its own main).

**Evidence of it working:**
- Tests (`apps/server/test/`):
  - `coord-engine.test.ts`, 5 tests: symbol outlines, change attribution, three-way test-merge with named conflicts.
  - `coordination.test.ts`, 2 tests: briefing, mid-turn conflict told in the tool result and logged in both sessions, resolution, branch vs main, laptop work.
  - `codev-features.test.ts`, 3 tests: Live main ordering and precise blame, combined preview, Board lanes, duplicate warning, and the full MCP flow (401 without a token, announce → radar conflict, suggest without steering, clear).
  - All pass on both the git backend and the serverless database backend.
- A real two-browser run (screenshots in `.ui-improve/shots/coord-*.png`) showed "Conflict caught" in Sai's log, the mock agent saying it would fit around Sai's work, the Board flagging both cards, and Live main marking Sai's work "Doesn't fit yet, collides with Ayan's work".
