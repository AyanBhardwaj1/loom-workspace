# 🧵 Loom — multiplayer AI software development

**What Google Docs did to Word, Loom does to AI coding sessions.**

When a team builds with AI coding agents today, one person drives a session and
everyone else waits, splits tickets, or pulls stale commits. Loom makes the
**session itself** the shared, live, forkable object:

- **Chat with an agent** that reads and writes your project's real code.
- **Spectate teammates live** — every prompt, streamed token, tool call, file
  diff and commit, as it happens, in a sidebar next to your own work.
- **Fork any session at any point** — you get a copy of the conversation *and*
  the code state, and keep building while they keep driving, uninterrupted.
- **Version control for humans** — every change is auto-committed and
  explained twice: a technical summary for engineers, plain English for
  everyone else.

Seeded with five founders — Prithviraj, Ayan, Sai, Ashwin and Aarush — and a
demo project (**Nimbus**, a team wiki app) so the multiplayer moment is 60
seconds away.

## Features

Everything below is discoverable from the **⌘K palette** and a visible control:

- **Live spectate + fork** — watch any teammate's stream; *Fork & continue*
  from the latest point, or hover any event and fork from exactly there.
- **Session replay** — every session is a replayable object: scrub, play at
  1×/2×/4×, step with ←/→, fork from any point (`r` inside a session).
- **File evolution player** — files touched more than once get *Play
  evolution*: a token-level magic-move through each saved state.
- **Live preview** — the session's build served in a sandboxed iframe,
  reloading on every commit; *Preview main* shows the merged product.
- **Suggestions** — spectators propose next steps; the driver accepts (runs
  as a credited turn) or dismisses.
- **Reactions & comments** — pin a reaction or comment to any event without
  interrupting the driver; they land in the log and in replays.
- **Pass the wheel** — atomic driver handoff: offer → accept → the log
  continues unbroken and the composer changes hands.
- **Live read presence** — spectators' avatars dock to the thread beside the
  event they're reading — co-presence, Figma-style.
- **Stop generation** — interrupt mid-turn; partial work is still committed.
- **Share links** — revocable read-only links (`/shared/<token>`), no login.
- **Export as Markdown** — the full transcript, diffs and commits as one file.
- **Session digest** — every ended session closes with an artifact: bullets,
  files, commit count, duration, and *Fork & continue*.
- **Notifications** — forked/merged/reacted/handoff, live-pushed with a quiet
  lavender dot.
- **Cost visibility** — live token/cost meter per session and per module
  (hidden in mock mode).
- **Keyboard-first** — `⌘K` palette, `?` shortcut sheet, `h` history,
  `[` `]` spectate panel.

## The architectural insight

**No CRDTs. No operational transforms.** Each session has exactly one writer
(the driver), so a session is just an **append-only event log** — trivially
streamable to any number of spectators, and trivially copyable, which is all a
fork is: copy the log, cut a git branch at the last commit, keep going.
Multiplayer emerges from *many* sessions over *one* repo, reconciled through
git branches and agent-assisted merges. That's what makes this buildable now.

Concretely:

- `SessionEvent` (in `packages/shared`) is the atom: `user_message`,
  `assistant_delta` (broadcast-only), `assistant_message`, `tool_call`,
  `tool_result`, `file_change`, `commit`, `status`, `fork_marker`. The
  persisted log is the source of truth; chat UI, spectator sidebar and forking
  are just views/copies of it.
- Every session owns a **real git branch and worktree** under `./data`. Every
  agent turn that touches files is auto-committed with the driver as author.
- The agent runtime is one provider-agnostic loop. `ANTHROPIC_API_KEY` set →
  real Claude (streaming + tool use). Unset → a deterministic
  **MockAgentProvider** that narrates, calls the same sandboxed tools, and
  really builds files — the whole product works with zero API keys.

## Quickstart

Requirements: Node 20+, pnpm 9, git.

```bash
pnpm install
pnpm seed     # five founders + the Nimbus demo project (password: loom-demo)
pnpm dev      # server on :3001, web on :5173
```

Open http://localhost:5173 and use the one-click dev logins.

## The 60-second demo

1. **Browser A**: quick-login as **Ayan** → open **Nimbus** → **Landing page**
   → *Start session* → send *“Build a hero section with our name and a
   waitlist form.”* Watch the narration stream, tool chips appear, diff cards
   land, and a commit row with a plain-English explanation. The files are
   really on disk (`data/projects/<id>/worktrees/<session>/index.html`) and
   really committed (`git log` on the session branch).
2. **Browser B (incognito)**: quick-login as **Sai** → the dashboard shows
   Ayan's card pulsing with his live activity → *Watch* his session and see
   his events stream in.
3. Sai clicks **⑂ Fork & continue** → lands in his own session holding Ayan's
   full transcript and code → sends *“Now add a features grid below the
   hero.”* Both sessions run simultaneously; Ayan's transcript shows
   *“⑂ Sai forked from here”*; Sai's spectator sidebar streams Ayan's ongoing
   session.
4. **Version history** shows both branches' changes with a **Simple /
   Technical** toggle, per-file diffs, and a file browser at any commit.
   Merge Ayan's branch into main — it appears live in Sai's browser.
5. Solo? The dashboard's **▶ Simulate teammate** button makes seeded founder
   Prithviraj start a believable live session (same pipeline, zero special
   cases) so you can spectate and fork alone.
6. Want the real thing? Click the **⚙ gear → AI provider**, paste an
   Anthropic or OpenRouter key (any OpenAI-compatible endpoint works via the
   base-URL field), and every session switches to the real model instantly —
   no restart, and spectators see the same live stream. `pnpm test` runs the
   suite; `ANTHROPIC_API_KEY` in the env works too.

## Stack

pnpm workspaces: `apps/web` (Vite + React 18 + Tailwind + TanStack Query),
`apps/server` (Node 20+, Fastify, `ws`, Drizzle ORM), `packages/shared`
(zod-validated event + WS protocol schemas — the contract for DB, wire and
UI). SQLite by default, Postgres via `DATABASE_URL` (mirrored schema +
migrations for both). Real `git` via `execa`: worktrees, branches, merges.
Agent tools (`list_files`, `read_file`, `write_file`, `edit_file`,
`delete_file`, allowlisted `run_command`) are hard-sandboxed to the session's
worktree.

```
apps/server/src
├── agent/         orchestrator turn loop, sandboxed tools, providers (mock + Anthropic)
├── git/           GitService (worktrees, diffs, merges) + MergeService
├── realtime/      EventBus (Redis-adapter-ready) + WS hub (sub/catchup/presence)
├── sessions/      the event log: append, catchup, create, fork, end
├── projects/      projects, modules, members, changes
└── routes/        cookie-authed HTTP API
```

## Testing

```bash
pnpm test
```

Unit tests for the pure core (event schemas, protocol codecs, tool sandbox,
provider selection) and integration tests that drive the real server: a full
mock-agent session (events → disk → git log → change row), fork mechanics
(source provably untouched, branches diverge), and a two-client WebSocket
test (driver + spectator + catchup + rejection paths).

## Deploying

`Dockerfile` + `docker-compose.yml` (app + Postgres + persistent `/data`
volume) included — see [DEPLOY.md](DEPLOY.md) for Compose, generic VPS,
Fly.io and Railway walkthroughs. One instance for now: the event bus is
in-process behind an interface (a Redis adapter is the multi-instance path).
