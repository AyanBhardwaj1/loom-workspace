# Deploying Loom

Loom is one Node process (Fastify HTTP + WebSocket + agent runtime) that also
serves the built frontend, plus a database (SQLite by default, Postgres via
`DATABASE_URL`). The one unusual requirement: **the `git` binary must exist in
the runtime environment**, and **`LOOM_DATA_DIR` must be persistent** — it
holds every project's git repository and every session's worktree. Lose it and
you lose the product's real state.

## Option 1 — Docker Compose (app + Postgres), any host

```bash
cp .env.example .env          # set COOKIE_SECRET, optionally ANTHROPIC_API_KEY
docker compose up --build -d
docker compose exec loom pnpm --filter @loom/server seed   # first run only
```

Open http://localhost:3001. Data lives in the `loom-data` volume, the DB in
`pg-data`. Set `NODE_ENV=production` in `.env` to disable the dev quick-login
and ghost teammate.

## Option 2 — a generic VPS (no Docker)

Requirements: Node 20+, pnpm 9, git.

```bash
git clone <your-loom-repo> && cd loom
pnpm install
pnpm build                          # builds apps/web/dist (served by the server)
cp .env.example .env                # set NODE_ENV=production, COOKIE_SECRET, etc.
pnpm seed                           # optional demo data
NODE_ENV=production pnpm --filter @loom/server start
```

Put nginx/Caddy in front for TLS. The WebSocket endpoint is `/ws` — make sure
your proxy passes `Upgrade`/`Connection` headers, e.g. for nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3001;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_read_timeout 1h;            # long-lived spectator sockets
}
```

Set `COOKIE_SECURE=1` once TLS is on. Run it under systemd:

```ini
[Service]
WorkingDirectory=/opt/loom
ExecStart=/usr/bin/pnpm --filter @loom/server start
Environment=NODE_ENV=production
Restart=always
```

## Option 3 — Fly.io

```bash
fly launch --no-deploy              # uses the Dockerfile; pick a region
fly volumes create loom_data --size 3
fly secrets set COOKIE_SECRET=$(openssl rand -hex 32) ANTHROPIC_API_KEY=sk-ant-...
fly deploy
fly ssh console -C "pnpm --filter @loom/server seed"
```

In `fly.toml`, mount the volume and keep one machine (the event bus and
presence are in-process — see the scaling note):

```toml
[mounts]
  source = "loom_data"
  destination = "/data"

[http_service]
  internal_port = 3001
  force_https = true
  min_machines_running = 1
```

SQLite on the volume is fine for a team; attach Fly Postgres and set
`DATABASE_URL` to switch.

## Option 4 — Railway

1. New project → Deploy from repo. Railway detects the Dockerfile.
2. Add a **Volume** mounted at `/data`.
3. Add the **Postgres** plugin; set `DATABASE_URL` to its connection string.
4. Set `COOKIE_SECRET`, `NODE_ENV=production`, optionally `ANTHROPIC_API_KEY`.
5. Deploy, then run `pnpm --filter @loom/server seed` from a one-off shell.

## Scaling note (read before adding replicas)

Run **one instance**. Realtime fanout uses an in-process `EventBus`
(`apps/server/src/realtime/bus.ts`) and presence lives in server memory. The
bus is behind an interface, so a Redis pub/sub adapter (plus sticky sessions
or shared presence) is the path to multi-instance — it's a deliberate
non-goal for now, and everything else (DB, git on a shared volume) is already
multi-instance-shaped.
