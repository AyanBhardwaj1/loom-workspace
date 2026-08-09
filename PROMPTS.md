# Improvement prompt

Paste the block below into a fresh Claude Code session in this repo when you want
to push the product to its next level. It encodes the August 2026 market research
findings (see git history / ask for the research summary) as engineering priorities.

---

You are working in ~/MultiplayerAI — "Loom", a complete, working multiplayer AI
development workspace. Before writing any code: read README.md, DEPLOY.md, and
skim packages/shared/src (the event/protocol contracts), apps/server/src/agent
(orchestrator + providers + runtime), and apps/server/src/sessions/service.ts
(the event log + fork mechanics). Run `pnpm install && pnpm seed && pnpm test`
to confirm the baseline: all tests must be green before and after your work.
The app runs with `pnpm dev` (server :3001, web :5173, dev quick-login as the
seeded founders, password loom-demo). A deterministic mock agent works with zero
API keys — every change you make must keep mock mode fully working, because it
is the demo and the test substrate.

Context you must respect: the architecture is a single-writer append-only event
log per session, streamed to many readers, with git branches/worktrees for
parallelism. Do not introduce CRDTs, do not add a second source of truth, and do
not break the invariant that assistant_delta events are broadcast-only (never
persisted). Market research (Aug 2026) found our unique, unshipped-anywhere
composite is: fork a colleague's LIVE session at any event, carrying both the
conversation and the exact code state. Warp, Amp, Factory, Devin, and Entire
each ship fragments; none compose them. Research also found that live
co-presence tools historically die (Code With Me, Live Share, CoScreen) while
ASYNC replay + explanation is what retains — so every feature below must work
as well for a viewer arriving 3 hours late as for one watching live. The
highest-value audience is someone who did NOT drive the session: a teammate,
a PM, or an agency's client.

Build these, in order, one milestone commit each:

1. LIVE PREVIEW OF THE BUILT PRODUCT. Sessions build real web files in their
   worktree, but nobody can SEE the product. Add a preview pane to SessionView
   (toggleable, split with the chat): the server statically serves each
   session's worktree at /preview/:sessionId/* (sandboxed iframe, no parent
   access, path-traversal-proof — reuse the worktree sandbox discipline
   already in apps/server/src/agent/tools.ts), auto-reloading on each commit
   event. Also serve /preview/main/:projectId/* for the merged main branch on
   the Version History page. This turns "watch diffs scroll by" into "watch
   the product assemble itself", which is the demo moment for non-engineers.

2. SESSION REPLAY + SHARE LINK. A read-only route /replay/:sessionId that
   plays the persisted event log like a recording: play/pause, speed control,
   a timeline scrubber with commit markers, and "⑂ fork from here" on every
   scrubber position (reusing the existing fork-at-event API). Add a
   "Copy replay link" button in SessionView. Auth: project members only for
   now, but structure the route so a future signed public-link mode (for
   agency clients) is a config flag away. This is the growth loop the market
   research identified — build it before any other sharing feature.

3. SPECTATOR PRESENCE THAT DOES SOMETHING. Spectators can currently only
   watch or fork. Add lightweight steering: a spectator can send a
   "suggestion" (new event type `suggestion`, persisted, rendered as a
   distinct card in the driver's chat with Accept / Dismiss). Accepting
   injects it as the next user_message credited to the suggester ("Sai
   suggested: …"). Extend the shared zod schemas properly — schema first,
   then server, then UI, then tests. Keep the single-writer invariant: only
   the driver's accept turns a suggestion into agent work.

4. INTERRUPT AND QUEUE. The driver currently cannot stop a running turn. Add
   a Stop button (server cancels the in-flight provider stream cleanly,
   commits whatever tool work already happened, appends status idle with note
   "Stopped by driver") and let the driver type while the agent works —
   queued messages render as "queued" and dispatch when the turn ends. The
   orchestrator's turn loop in apps/server/src/agent/orchestrator.ts is the
   place; thread an AbortSignal through the provider interface (all three
   providers: mock, anthropic, openrouter).

5. COST + TOKEN VISIBILITY. When a real key is active (see
   apps/server/src/agent/runtime.ts), track per-turn token usage and
   estimated cost (providers return usage in their APIs; the mock should
   fabricate plausible numbers so the UI is testable). Show a small
   cumulative cost chip in the session header and per-session totals on the
   module page. Teams fear runaway agent spend — visible cost is trust.

6. RENAME SCAFFOLDING. Atlassian owns an incontestable LOOM trademark in
   collaboration software — the product must be renamed before any public
   launch. Do a mechanical rename pass: introduce a single BRAND constant
   used by all UI strings, the README, package names, and seed copy, so a
   future `git grep loom` shows only the constant's definition site plus
   package-manager plumbing. Do not pick the new name — leave BRAND="Loom"
   and a NAMING.md explaining the constraint and where to change it.

7. TWO-BROWSER E2E TEST. Add a Playwright test (new apps/web test setup) that
   drives the real stack: browser A logs in as Ayan, starts a session, sends
   a message; browser B logs in as Sai, watches the live stream arrive,
   forks, continues, and merges. Wire it as `pnpm e2e`. This is the product's
   soul as an executable test — it must pass in mock mode with no keys.

Discipline, non-negotiable: after each milestone run `pnpm check && pnpm test`
and fix everything before moving on; verify visually in the browser (use two
windows for anything multiplayer — the second window logged in as a different
founder); when all milestones land, run an adversarial self-review pass over
your own diff hunting for the classes of bug that bit this codebase before
(state races across the WS layer, fork edge cases at event boundaries, path
traversal in anything serving files, StrictMode double-invocation in React,
secrets leaking into child processes or API responses), fix what you find, and
add a regression test per fix. Commit messages follow the existing style: what
+ why, milestone-sized.

---
