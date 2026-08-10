# Loom — Design System

The precision-instrument revamp. Dark charcoal only; muted lavender; Geist; quiet at rest,
cinematic at exactly six moments. This document is the source of truth for tokens, motion,
choreography, and stack guardrails. (Token values land in §2 alongside the implementation.)

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

## 2. Tokens — implemented in `src/styles/tokens.css` (§4 of the brief)

*(filled in by the tokens milestone — see that file for values; rules below are the contract)*

- Zero one-off hex values outside `tokens.css` and the shiki theme.
- Hairlines only — 1px; three alphas (0.06 / 0.10 / 0.15). No 2px borders.
- Lavender = liveness + primary action ONLY. The only glow: `--lav-glow` on live elements.
- Text on lavender fills is dark `#131316`.
- Radii: 6 (controls) / 8 (cards) / 10 (modals) / 999 (pills). Nothing else.
- Space grid: 4px; scale 4·8·12·16·20·24·32·40·48.
- Type: Geist Sans/Mono, weights 400/500/600; scale micro 11/16 · small 12/18 · ui 13/20 · body 14/23 · h4 16/24 · h3 18/26 · h2 20/28 · display 24/32. `tnum` on all numerals.
- Elevation = surface ramp + hairlines. Two shadows only (modal, dropdown).
- z-index: content 0 · sticky 10 · sidebar 20 · dropdown 30 · scrim 40 · modal 50 · toast 60.

## 3. Motion

- `--t-micro 120ms` hovers/toggles · `--t-fast 180ms` fades/fills · `--t-enter 240ms` rows/modals · `--t-moment 420–700ms` (six moments only).
- Eases: `loom-out cubic-bezier(0.25,1,0.5,1)` (entrances) · `loom-standard cubic-bezier(0.2,0,0,1)` · exits `cubic-bezier(0.4,0,1,1)`. Registered as GSAP CustomEases with the same names.
- Routine interaction is CSS-only. GSAP lives exclusively in `src/lib/choreography/`.
- Banned: hover-scale everywhere, page-wide staggered entrances, parallax, looping decoration (exceptions: streaming current, canvas drift).
- `prefers-reduced-motion`: every moment → ≤180ms fade (gsap.matchMedia); shader frozen; pulses static.

### Choreography table (the six moments)
| # | Moment | Trigger | Duration | Plugins |
|---|---|---|---|---|
| M1 | Session start | fresh session mount | 600ms + 400ms breathe | DrawSVG |
| M2 | Agent awakens | first assistant_delta of a turn | 400ms pulse; sustained current while streaming | – (CSS current + GSAP pulse) |
| M3 | The fork (hero) | Fork & continue / fork-from-event | ~500ms branch + avatar ride | DrawSVG, MotionPath |
| M4 | Commit settle | commit event lands | ~400ms node + ripple + stagger | – (GSAP core) |
| M5 | Merge join | merge into main (history) | 600ms morph + 500ms bloom | MorphSVG |
| M6 | Replay glide | scrubbing the replay timeline | tracked; 160ms/event materialize | DrawSVG progress |

## 4. Stack guardrails (Part III)
- **gsap** — only in `src/lib/choreography/`; only DrawSVG/MorphSVG/MotionPath/Flip/CustomEase; matchMedia reduced-motion fallback at every timeline.
- **@paper-design/shaders-react** — ONE MeshGradient behind the root; charcoal ramp + `#191627`; DPR ≤1.5; `speed 0` when hidden/reduced-motion; CSS radial fallback. Reads as atmosphere or gets deleted.
- **shiki** — `loom-charcoal` theme everywhere code renders. **magic-move** only in evolution/replay contexts.
- **@number-flow/react** — every number that changes while visible; house timings; `tabular-nums`.
- **cmdk / sonner / vaul / react-resizable-panels / @tanstack/react-virtual / lucide (16px, 1.5px stroke) / Radix behavior** — all fully restyled from tokens. If a screenshot reveals the library, restyle until it doesn't.
- No component ships in its library's default skin. No GSAP outside choreography/. No `!important`.

## 5. Hard bans (Part XI) — grep-able checklist
glassmorphism/backdrop-blur cards · gradient text · purple→blue washes · glow beyond `--lav-glow` · emoji-as-icon · default library skins · visible mesh-gradient · cards-in-cards · radius >10px · in-app hero sections · shadow soup · pure #000/#FFF · decorative loops · 2px borders · `!important` · GSAP outside choreography/
