# Loom — Design System

**Swiss Industrial Print** (Oct 2026 rehaul — replaces the dark lavender "precision instrument"
system entirely). Paper, ink and one signal red; Archivo (variable width) + JetBrains Mono; radius 0;
frames, not shadows; uppercase mono telemetry for every label. The product reads like a printed
operations sheet that happens to be live. This file is the source of truth for tokens, motion and
the multiplayer-testing architecture.

---

## 1. Inventory (Part II) — every route, component, state

### Routes
| Route | Screen | Notes |
|---|---|---|
| `*` (logged out) | `Login` | quick-login founder list (dev), email/password form, signup toggle |
| `/` | `Home` | project cards grid, new-project dialog, AI provider chip/gear, sign out |
| `/replay/:sessionId` | `ReplayView` | outside the project shell; transport bar, scrubber, commit ticks, speed segments, fork-from-point, copy link |
| `/p/:projectId` | `ProjectShell` → `ProjectDashboard` | left rail (becomes 48px top bar), module cards, recent-changes feed, presence, Simulate teammate (dev) |
| `/p/:projectId/m/:moduleId` | `ModuleView` | live-now sessions, past sessions, per-module token/cost, Start session |
| `/p/:projectId/s/:sessionId` | `SessionView` | event log, composer (driver) / suggest bar (spectator), preview pane, spectator sidebar, header status |
| `/p/:projectId/room` | `RoomView` | live wall: every live session's product (signed preview, scaled), testers' pointers, checks verdict, current plan step; merged main below |
| `/p/:projectId/history` | `HistoryPage` | branches strip + merge, change timeline, Simple/Technical, change slide-over (diffs + file browser), preview main |

### Event log renderings (all 12 event types)
- `user_message` — bubble (+ `suggestedByName` credit)
- `assistant_delta` — transient streaming text + caret
- `assistant_message` — bare prose, inline `code`
- `tool_call`/`tool_result` — merged chip (6 tools: list_files, read_file, write_file, edit_file, delete_file, run_command), running/ok/error states, expandable args/result
- `file_change` — diff card (create/edit/delete), +N −M, collapse/expand
- `commit` — Simple explanation + technical summary + SHA chip (copies)
- `status` — quiet centered note (errors + terminal notes only; thinking/running drive the indicator)
- `fork_marker` — "X forked from here" row
- `suggestion` + `suggestion_decision` — spectator suggestion card w/ accept/dismiss (driver), accepted/dismissed states
- `usage` — not a row; feeds header token/cost meter
- `check_run` — printed report: verdict tile (Pass/Warn/Fail) + each check; passes fold away when something failed
- `plan` — numbered steps, current one tagged NOW; one row per turn (later updates replace it in place); latest also pinned as the `PlanStrip`
- `check_started` — transient; drives "X is running checks" in the dock and Room

### Components
`ui.tsx`: Avatar, AvatarStack, StatusPill, Led, AgentStatusIndicator, Spinner, Dialog, SlideOver, EmptyState, ErrorState, CardSkeleton
`ChatLog` (thread + autoscroll + jump-to-live), `EventRow` (+ToolChip, DiffCard/UnifiedDiffView/DiffStats, CommitRow, SuggestionCard, InlineText), `Composer` (queue chips, Stop, notices), `SpectatorSidebar` (session picker, compact log, fork CTA), `PreviewPane` (sandboxed iframe, reload/flash), `AiSettingsDialog` (+AgentModeChip, useAiSettings)

### State/lib
`auth.tsx` (AuthProvider: me/dev-users/login/signup/devLogin/logout), `useSessionStream` (fetch+sub+catchup+dedupe+delta accumulation), `useReplayStream` (read-only log + live appends), `useProjectFeed` (presence, per-module gists, live changes, merge notes, query invalidation), `ws.ts` (singleton client: sub/unsub, viewing, user_message, stop, suggest, resolve_suggestion, catchup; backoff reconnect), `api.ts`, `time.ts`

### Meta-states present today
initial loading (Spinner / CardSkeleton), error (ErrorState / inline), empty (EmptyState variants per screen), WS reconnect (composer notice only — banner comes with revamp), ended session (banner + fork), merge success/failure notes, preview loading, suggestion sent confirmation, queued messages.

### Locked test contract (MUST NOT change — e2e + server tests depend on these)
- `data-testid="quick-login-${email}"` (Login)
- Home project card is a **link** whose accessible name contains the project name (/Nimbus/)
- `data-testid="module-card-${module.name}"` (Dashboard)
- Button name /Start session/ (ModuleView)
- Composer textarea placeholder /Tell the agent what to build/
- Button name `Send` (exact) (Composer)
- Commit explanation text `<Name> asked the agent to …` rendered in the log
- Button name /Fork & continue from here/ (SessionView spectator bar)
- Heading /Version history/ (HistoryPage)
- Button name /Merge into main/ (BranchesStrip)
- Merge note text matching /Merged cleanly into main|part of the main version/
- Replay page shows the text `Replay` exactly — `Pill` draws its `[ ]` brackets with CSS pseudo-elements so a pill's text content is only its words

### Already built in earlier milestones (Track B/C items that upgrade, not build-from-scratch)
- F2 replay: `ReplayView` + `useReplayStream` + `/api/replay/:id` exist → restyle + M6 + palette entry
- F3 fork-from-event: server `fork({ atEventId })` + row hover affordance exist → new ghost-icon + confirm popover UI
- F5 read presence: session-level `viewing` presence exists → extend to event-level read position
- F10 stop: AbortSignal through providers + Stop button exist → restyle per §7.4 honesty rule
- F14 cost meter: per-turn `usage` events + header chip + module totals exist → NumberFlow + tooltip breakdown
- C4 partial: WS backoff reconnect + catchup-from-seq + resub exist → add heartbeat, jitter, hidden-tab pause, banner
- C9 partial: two-browser demo-flow spec exists → keep green; add replay + fork-from-event specs
- C6 partial: path-traversal tests exist for preview route; sandbox tests for file tools to audit/extend

### Server seams (Track B/C)
`realtime/hub.ts` (WS cases: sub/unsub/sub_project/viewing/user_message/stop/suggest/resolve_suggestion/catchup) · `realtime/bus.ts` (EventBus interface → C10 Redis adapter) · `sessions/service.ts` (appendEvent, fork, usage totals) · `agent/orchestrator.ts` (turn lifecycle, abort) · `routes/replay.ts` (`canAccessReplay` seam → F11 share tokens) · `routes/sessions.ts` · `git/mergeService.ts` (→ F15) · `app.ts` (route registration, cookies → C6)

---

## 2. Tokens — `src/styles/tokens.css` (only place for raw colour values, plus `lib/highlighter.ts` and `lib/identity.ts`)

| Role | Value | Notes |
|---|---|---|
| paper (canvas) | `#F4F4F0` | body carries a 48px blueprint grid at 4.5% ink |
| sheet (surface/overlay) | `#FBFBF8` | cards, panes, popovers |
| raised / inset | `#EEEDE7` / `#E9E8E2` | hover zones / code, wells, inputs |
| ink | `#111111` (17:1) · `#3B3B37` (10:1) · `#5F5E58` (5.3:1 even on inset) | primary / secondary / tertiary text |
| rules | hairline `rgba(17,17,17,.16)` · hover `.32` · strong `#111` | frames use the strong rule; 2px for page/section rules |
| signal | `#D01414`, white text on it (5.5:1) | the ONE accent: live, primary hover, NOW, failures, selection |
| ok / warn | `#1C7A3A` / `#8A5A00` | white text on both fills passes 4.5:1 |
| identity inks | `#F2C230 #4FB3D9 #6BBF59 #F08A3C #F07FA8 #C9C3B5` | stored avatar colours are hashed onto these (`identityColor`) — no migration; ink text on all |

- **Radius 0 everywhere** (Tailwind `borderRadius` all `0`).
- **Frames, not shadows.** Modals: `0 0 0 2px ink, 8px 8px 0 ink@12%`. Dropdowns: 1px ink + 4px offset. Interactive cards lift with a hard 4px ink offset shadow on hover (no blur, ever).
- **Live** = an inset 2px signal frame (`--glow-live`) + the red `LivePill` square. No glows.
- **Type:** Archivo Variable (wdth 62–125) for UI and display; JetBrains Mono for code, numbers and telemetry.
  - `.font-display` — stretch 68%, weight 900, uppercase, tight leading. Page titles only.
  - `.telemetry` — mono 11px uppercase, tracking .08em. Every label, tag, pill, meta line.
  - scale: micro 10.5 · small 12 · ui 13.5 · body 15 · h4 17/700 · h3 21/800 · h2 28/850 · display clamp(40→76px).
- **Modules are units**, not emoji: `U-01…` ink tiles (`unitCode`). Sessions on the Room wall are `S-01…`.
- **Pills** read `[ BUILDING ]` (brackets drawn in CSS). Buttons are uppercase semibold; primary is an ink slab that turns signal red on hover.
- Shiki theme `loom-print` (light; keywords ink bold, strings green, numbers amber, types deep red).

## 3. Motion

- `--t-micro 90ms` · `--t-fast 140ms` · `--t-enter 200ms` · `--t-moment 420ms`. Mechanical eases (`--ease-standard cubic-bezier(.3,0,.1,1)`): print things snap, they don't float.
- GSAP only in `src/lib/choreography/` (fork / commit-settle / merge-join / replay moments, decoration-only).
- Live multiplayer motion is functional, not decorative: teammates' pointers glide 140ms linear; a teammate's click is one square pulse (`.loom-click-ripple`, 700ms, then gone); the current plan step pulses.
- `prefers-reduced-motion`: global clamp to ~0ms; pointer glides and hover lifts are disabled.

## 4. Stack guardrails
- No component ships in its library's default skin (cmdk, sonner, vaul, Radix, react-resizable-panels all restyled from tokens).
- `cn()` uses `extendTailwindMerge` with the role-named font sizes — otherwise `text-ui` is read as a colour and deletes the real text colour.
- Links styled as buttons use `buttonVariants` — never `<Link><Button>`.
- Fonts self-hosted in `public/fonts` (Archivo + JetBrains Mono, latin + latin-ext), preloaded.

## 4b. Structure conventions
- One `<h1>` per page: `PageHeader` (display title, telemetry meta, 2px ink rule beneath) on Home / Dashboard / Module / Room; the session and replay titles are the `<h1>` in their bars.
- `SectionLabel` = telemetry label ruled to the edge (`LIVE NOW ————`).
- Top bar: wordmark · project switcher · ink-tab nav (DASHBOARD · ROOM · HISTORY; active tab is an ink slab) · ⌘K · presence · bell · settings · account. 2px ink rule beneath.
- Session layout: log | **test bench** (open by default, remembered) | spectate. The log carries the catch-up card and the pinned plan strip above it.
- Forms: visible labels, `name`, `autocomplete`; errors `role="alert"`, live statuses `role="status"`.

## 5. Multiplayer testing — how the group sees each other test

Research basis (summarised in the PR/report): workspace awareness speeds coordination (Gutwin & Greenberg); agents should verify "as a human user would" and surface it; human-gated steering beats autonomous AI steering; single writer per session (the driver); catch-up digests for rejoiners; visible plans/intent.

1. **Bridge.** The server injects `<script src="/preview-kit/bridge.js" defer>` before `</body>` of every HTML file it previews (`apps/server/src/preview/bridge.ts`). Inside the sandboxed frame it postMessages pointer (≤20/s), clicks (element role + visible label — never typed values; the source must not contain `.value`), scroll, page and runtime errors to the parent; it accepts only `scrollTo` from the parent (follow mode).
2. **Relay.** `PreviewPane` accepts frames only from its own iframe's `contentWindow`, clamps every field, converts paths to **root-relative** (`/about.html`) and sends `preview_presence` over the WS. The hub rate-limits (25/s), checks membership (cached per connection) and **stamps identity server-side** — a page can't impersonate anyone.
3. **Render.** `useTestPresence` keeps per-tester pointer/scroll/page (stale after 12s) and a 40-item action feed. The bench draws teammates' pointers in *our* scroll coordinates, click pulses, a LIVE TESTING feed, follow mode (mirror a teammate's page + scroll), and **Flag bug** (attaches your last 8 steps + errors; the driver sends it to the agent, a spectator files it as a suggestion the driver accepts — humans gate the agent).
4. **Signed preview URLs.** The sandboxed frame has an opaque origin, so browsers send no SameSite cookie with its asset requests (before this, every preview's CSS/JS was blocked: 401 → ORB). Frames load `/preview/t/<token>/…` minted by `GET /api/preview-url` — HMAC-signed, domain-separated from cookies, bound to one user + one workspace, 8h expiry, membership re-checked on every request, `Referrer-Policy: no-referrer`. "Open in new tab" still uses the cookie route.
5. **Checks.** `runChecks` (entry page, links & assets, page basics, image alt, stylesheets, JS syntax, the project's own `npm test` when defined). Runs statically after every agent commit, on demand (RUN CHECKS — any member), and by the agent via the `run_checks` tool. `check_started` is broadcast live; `check_run` is persisted, so replay and catch-up see it.
6. **Plan.** The agent's `update_plan` tool persists a `plan` event; the latest is pinned above the log and shown as NOW on the Room wall.

7. **Session state (derived).** `deriveSessionState()` (`@loom/shared`) computes working · checking · needs-testing · your-move · error · idle · stale · ended from the log alone; `StateChip` renders it in the session header and on Room tiles, with the current activity ("editing index.html").
8. **Steering at safe points.** While the agent works the driver can *Steer now* (⌘/Ctrl+Enter). The `steer` event is visible at once; the orchestrator appends it to the next tool result (never mid-edit) and records `steer_applied {afterTool}`; a steer that never meets a boundary becomes the next turn. Plain Enter still queues for after the turn.
9. **Team-verified test cases.** The agent's `propose_tests` tool persists `test_plan` (action → expect). Any member marks Pass/Fail (+note) — `POST /api/sessions/:id/tests` → `test_verdict` (unchanged repeats are no-ops). Failures toast the driver, show in the catch-up card, and enter the agent's next-turn transcript. Verdicts are human evidence; automated judges are advisory only (research: `.ui-improve/research-multiplayer-ai.md`).
10. **Smaller steps nudge.** The composer flags a single prompt over 700 chars or with ≥4 list items.

## 5b. The room enforces what the room agrees (market-gap research, Oct 2026)

Evidence: `reports/Multiplayer AI builder market gaps.md` — every product examined guards one person + one agent; the incidents (Replit prod-DB deletion during a prompt-only freeze, Antigravity drive wipe, Lovable RLS exposure) all lacked a second person with authority at the moment of change.

- **Verified-to-merge gate** (`evaluateMergeGate`, `@loom/shared`): checks pass on the latest version (an agent run in the same turn counts if nothing was written after it), every proposed test case passed *after the latest commit* by someone other than the driver, and the merger isn't the driver. One-person projects skip the second-person rules. Modes: `enforce` (new projects), `warn` (existing/seeded — merges, history says "Merged before verification was complete"), `off`. Only the owner can override, with a reason written into the merge commit and history. Shown rule by rule in History.
- **Stale verdicts**: a verdict older than the latest commit no longer counts (gate, "needs testing" state) and shows as *Stale — re-check* in the test cases.
- **Provenance trailers** on merge commits: `Driven-by`, `Steered-by`, `Suggested-by`, `Verified-by`, `Merged-by`, `AI-Assisted`, plus `Merge-Override` / `Verification: incomplete` when applicable.
- **Guarded actions** (enforced at the tool call, not in the prompt): `delete_file`, `run_command` (except `ls`/`cat`) and writes to protected paths emit `approval_request` and wait ≤2 min for an `approval_decision` from a member who isn't the driver (`POST /api/sessions/:id/approvals/:requestId`); lapses deny. Header state: NEEDS APPROVAL.
- **Freeze**: any member can freeze/unfreeze; while frozen every write tool is refused server-side; banner on every session.
- **Security checks**: `secrets` (fail — provider keys, private keys, service-role keys, committed `.env`; names the file, never the value) and `form-labels` (warn).
- **Ledger** (`/p/:id/ledger`): spend attributed to whoever was driving (handoffs record `previousDriverUserId`), by member/module/session; per-person contributions (prompts, steers, suggestions accepted, verdicts and failures caught, approvals, comments, forks, merges); Markdown contribution report with a reflection prompt.
- Room rules card on the dashboard: gate mode, guarded actions, protected paths (owner), freeze (anyone).

## 5c. Agents that keep each other posted (from reverse-engineering CoDev, Nov 2026)

Report: `reports/CoDev reverse engineering.md`.
- **Radar** (`apps/server/src/coord/radar.ts`, `engine.ts`): every active branch's changes by file and symbol (uncommitted edits included where the checkout is live), pairwise test-merges, each branch vs main. Laptop agents' announced work (paths + symbol names, 20-min TTL) is included.
- **Agent loop**: briefing in the per-turn context (`AgentTurnContext.coordination`); after write tools (≤ every 4 s) a NEW conflict is appended to the tool result and recorded as `coordination` events in both sessions; clean again → `resolved` ("conflicts caught before merge").
- **Live main** (`coord/liveMain.ts`): main + everyone's work by arrival (first commit); "doesn't fit yet" names the conflicting symbols and whose work; checked; previewable at `/preview/live/:projectId` (signed kind `l`).
- **Board** (`/p/:id/board`): lanes Needs you · Agent working · To review · Idle · Merged; branch-vs-main status; overlaps; laptop agents; live main panel.
- **Duplicate check**: before a session's first task, teammates' matching sessions → "Open their session" / "Start anyway".
- **MCP** (`POST /api/mcp`, personal `loom_pat_…` tokens): announce / radar / sessions / live main / read file / **suggest** (never steer — the driver decides).

## 6. Hard bans — grep-able
rounded corners · blurred shadows · glows · gradients on UI · glassmorphism/backdrop-blur · emoji as icons · dark-mode lavender anything · a second accent colour · default library skins · cards-in-cards · `!important` (except the reduced-motion clamp) · GSAP outside choreography/ · reading form values in the preview bridge
