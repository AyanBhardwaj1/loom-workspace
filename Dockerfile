# ── build stage: install workspace deps + build the frontend ────────────────
FROM node:22-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @loom/web build

# ── runtime stage: node + git (the git binary is a hard runtime dependency) ──
FROM node:22-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global --add safe.directory '*'
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
# project repos, worktrees and (if sqlite) the db live on this volume
ENV LOOM_DATA_DIR=/data
VOLUME /data
EXPOSE 3001
CMD ["pnpm", "--filter", "@loom/server", "start"]
