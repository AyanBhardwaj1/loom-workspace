// Builds Loom for Vercel as a prebuilt deployment (Build Output API v3):
//   .vercel/output/static            ← the web app, realtime over HTTP polling
//   .vercel/output/functions/api.func ← the whole Fastify server, bundled
//   .vercel/output/config.json        ← API/preview paths → the function, SPA fallback
// Deploy with:  vercel deploy --prebuilt --prod
// Only .vercel/output is uploaded — never data/, .env, or the source tree.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, '.vercel/output')
const fn = path.join(out, 'functions/api.func')

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(fn, { recursive: true })

console.log('› web (poll realtime)')
execSync('pnpm --filter @loom/web build', { cwd: root, stdio: 'inherit', env: { ...process.env, VITE_LOOM_REALTIME: 'poll' } })
fs.cpSync(path.join(root, 'apps/web/dist'), path.join(out, 'static'), { recursive: true })

console.log('› server function')
await build({
  entryPoints: [path.join(root, 'apps/server/src/vercel.ts')],
  outfile: path.join(fn, 'index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // the source is ESM and reads import.meta.url; give the CJS bundle a real one
  define: { 'import.meta.url': '__loomImportMetaUrl' },
  banner: { js: "const __loomImportMetaUrl = require('url').pathToFileURL(__filename).href;" },
  // native/optional modules never used on this platform (Postgres, no SQLite)
  external: ['better-sqlite3', 'pg-native', 'bufferutil', 'utf-8-validate'],
  sourcemap: 'inline',
  logLevel: 'warning',
  minify: false,
})
fs.cpSync(path.join(root, 'apps/server/drizzle/pg'), path.join(fn, 'drizzle/pg'), { recursive: true })
fs.writeFileSync(
  path.join(fn, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.cjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      maxDuration: 300,
      environment: {
        LOOM_PLATFORM: 'serverless',
        LOOM_MIGRATIONS_DIR: '/var/task/drizzle',
        NODE_OPTIONS: '--enable-source-maps',
      },
    },
    null,
    2,
  ),
)

fs.writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/(api|preview|preview-kit)(/.*)?$', dest: '/api', transforms: [{ type: 'request.headers', op: 'set', target: { key: 'x-loom-path' }, args: '/$1$2' }] },
        { handle: 'filesystem' },
        { src: '^/assets/(.*)$', status: 404 },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
)
console.log('✓ .vercel/output ready')
