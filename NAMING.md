# Naming — rename before launch

**"Loom" is a placeholder.** Atlassian owns an incontestable `LOOM` trademark in
collaboration software (they acquired Loom, the screen-recording company, for
~$975M in 2023). Shipping a developer-collaboration tool called "Loom" invites a
likelihood-of-confusion claim and an SEO black hole. **Pick a coined name and
file an intent-to-use application (USPTO classes 9 + 42) before any public
launch.**

This repo is structured so the rename is cheap.

## The one code switch

All user-facing runtime strings — the wordmark, the login/home headings, the
browser-tab title, the agent's system prompt, generated repo READMEs, the server
banner — read from a single constant:

```
packages/shared/src/brand.ts
  export const BRAND = 'Loom'
  export const BRAND_TAGLINE = 'Multiplayer AI development'
```

Change those two strings and every rendered surface updates. Do **not** hardcode
the product name anywhere else — import `BRAND` from `@loom/shared`.

## The remaining manual plumbing

A full rename also touches non-runtime plumbing that a constant can't reach.
Find every occurrence with:

```bash
git grep -i loom
```

After this scaffolding, the hits are only `brand.ts` plus the items below:

| What | Where | Notes |
|------|-------|-------|
| npm workspace scope `@loom/*` | `package.json` files + every `from '@loom/shared'` import | Internal only; renaming the scope is optional and touches many imports. Safe to leave for an internal tool. |
| Static tab title | `apps/web/index.html` `<title>` | A fallback; `main.tsx` overrides it from `BRAND` at load. |
| Data-dir env vars | `LOOM_DATA_DIR`, `LOOM_SQLITE_PATH` in `env.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `DEPLOY.md` | Rename together or existing deployments lose their data path. |
| Auth cookie name | `loom_session`, dev cookie-secret default in `auth/cookies.ts` | Renaming logs everyone out (fine). |
| Docker volume | `loom-data` in `docker-compose.yml` | Rename together with a volume migration, or leave. |
| Preview config name | `loom` in `.claude/launch.json` | Dev tooling only. |
| Seed demo data | founder emails `@loom.dev`, demo password `loom-demo` in `seed.ts` | These are **login credentials** shown in dev quick-login. Re-run `pnpm seed` after changing. |
| Docs | `README.md`, `DEPLOY.md`, `.env.example` | Prose; update by hand. |

## Verifying a rename

1. Edit `BRAND` (and optionally `BRAND_TAGLINE`) in `packages/shared/src/brand.ts`.
2. Work down the table above for a complete rename, or stop after step 1 for a
   UI-only rename.
3. `pnpm check && pnpm test` — everything is string-driven, so nothing should break.
4. `git grep -i "loom"` — confirm only intentionally-deferred plumbing remains.
