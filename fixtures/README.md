# Tested development setups

The fixtures exercise the built `@meanhq/mean` package, not separate browser implementations.
Run `corepack pnpm check` at the repository root to build, validate and test them.

| Fixture | Versions | Identity evidence |
| --- | --- | --- |
| `vite-react` | Vite 7.3.6, React 19.2.8, plugin-react 5.2.0 | component names, nearest-first chain and JSX source |
| `vue-vite` | Vite 7.3.6, Vue 3.5.30, plugin-vue 6.0.4 | component names, nearest-first chain and template source |
| `svelte-vite` | Vite 7.3.6, Svelte 5.55.1, vite-plugin-svelte 6.2.1 | template source and recorded nested owner names; mounted-root names are absent |
| `vite-dom` | Vite 7.3.6 | exact tag positions in both HTML entries; no component names |
| `next-webpack` | Next 16.3.4, React 19.2.8, Webpack | names, chains and JSX/JavaScript source in both routers |
| `next-turbopack` | Next 16.3.4, React 19.2.8, Turbopack | names, chains and JSX/JavaScript source in both routers |
| `webpack` | Webpack 5.110.3, webpack-dev-server 5.2.6, webpack-cli 6.0.1 | plain DOM only |
| `rspack` | Rspack core and CLI 2.2.2, dev-server 2.2.1 | plain DOM only |
| `express` | Express 5.2.1 | plain DOM only |
| `koa` | Koa 3.2.1 | plain DOM only |
| `python` | Python 3.14.2, standard-library http.server | plain DOM only, through the standalone relay |

Browser checks use Playwright 1.63.0 and Chromium 153.0.8010.12. Local checks use Node 24.12.0.
CI targets Node 20 and 22; the Rspack fixture needs at least Node 20.19 or 22.12.

## Host setup

Vite fixtures add `mean()` alongside their existing framework plugin.
The Vue and Svelte transforms stamp ordinary HTML templates; unsupported preprocessors retain whatever metadata the framework supplies.
Names and source are independent. A source is a reported render location, not necessarily a component definition.

The [Next integration](../packages/hosts/next/README.md) uses a separate loopback relay in the dev process, not a proxy.
Only stock Next 16.3.4 over HTTP is fixture-tested; HTTPS, basePath, assetPrefix and custom servers are disabled.
The host reads the served origin from `__NEXT_PRIVATE_ORIGIN` and checks it against `PORT`; Next 16.3.4 sets both in `dist/server/lib/start-server.js:295-296`, before config loads at line 392; `tests/next.test.ts` pins that file by hash.
A per-project lock shares one listener across workers. Interrupted claims or stale PID records can require manual cache cleanup after stopping the dev processes.

The [middleware integration](../packages/hosts/middleware/README.md) has examples for the 4 Node hosts.
It serves a module and attaches the shared relay; it does not add a framework compiler transform.
These plain DOM fixtures do not claim React or automatic source support.
Component HMR keeps the Mean socket alive. After a dev-server restart, reload the page.
Express and Koa use page reload rather than HMR.

The [Python fixture](python/README.md) uses an explicit backend-origin allowlist and a development-only module tag.
Rails, Django and Go are not individually tested; they can use the same standalone transport in development templates.

## Run one fixture

From the repository root, run `corepack pnpm build`, then for example:

```sh
corepack pnpm --dir fixtures/webpack dev
corepack pnpm exec vitest run tests/middleware.test.ts tests/middleware-e2e.test.ts
corepack pnpm exec vitest run tests/next-e2e.test.ts
corepack pnpm exec tsx fixtures/python/check.ts
```

Run one dev fixture at a time, or set a different `PORT` for each; each middleware fixture also has `build` and `start` scripts.
Browser tests use the fake-Mean harness for schema validation and timing and do not need a running Mean app.

## Exclusion and measurement

Vite production builds contain no runtime, adapter or source stamp.
Other servers use separate production entry points; an inactive middleware call alone cannot remove a static import from a server build.
Tests also run each middleware development entry under `NODE_ENV=production` and refuse module serving and socket upgrades.
The standalone CLI refuses production, and the Python production template omits the tag.

Browser tests check emitted artifacts and production endpoints, schema-valid messages, HMR or reload, and cold and warm page walk p50.
Cold means the first walk on a fresh page after its probe loads lazy modules; it excludes module loading.
Page timings run from receipt of a walk request to sending its result. Roundtrip timings also include transport.
Large-page measurements retain the protocol's 20 ms cooperative budget and may return a truncated prefix.
Source-edit checks use temporary fixture copies, never tracked files.

`fake-mean/index.ts` retains its original CLI and output for downstream integration checks.
No fixture proves atomic capture, pixel-perfect hit testing or automatic server-restart recovery for generic middleware.
