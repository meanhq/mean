# Python standalone fixture

Uses Python 3 `http.server` with 15,000 static elements. It has no framework metadata or source stamps, so component names and source locations must stay absent.

Run after building the public package:

```sh
corepack pnpm exec tsx fixtures/python/check.ts
```

The check starts the built standalone CLI, copies its module tag into the backend's development template and opens Chromium through Playwright. It validates relay and page messages against the schema. It checks cross-origin module loading, plain DOM results, privacy, an unlisted backend, production exclusion and clean SIGINT shutdown. It measures 20 fresh-page walks and 20 warm walks. Probe loading happens before each walk, so these numbers do not include cold module loading.

Playwright provides reproducible WebSocket timing instrumentation and fresh browser pages. The Python fixture needs no third-party Python packages.

For a backend development template:

```sh
npx @meanhq/mean --origin http://127.0.0.1:8000
```

Copy the printed ES module tag, including `referrerpolicy="no-referrer"`, into the development template only. Repeat `--origin` for each exact loopback backend origin. Keep browsing the backend URL. Do not put the tag into production templates or commit its page token.

The tag stays the same across restarts. The first start saves an OS-selected loopback port and a random project page token as private files under `node_modules/.cache/mean`. Without a local `node_modules` directory, it uses project-path hashes under `~/.mean/relays` instead. Run from the same project directory each time. Adding or removing its local `node_modules` changes the state location; preserve the private token and port files when doing so.

If the saved port is occupied, stop that server or use `--port N` to store a different port. `--rotate-token` replaces the project token. Both explicit changes print a new tag; replace the old tag and reload. Next uses the same project token but keeps an ephemeral port because its injection is generated automatically.

The fixture reads the tag from `MEAN_SCRIPT`. When `NODE_ENV=production`, it omits that tag and serves no Mean endpoints. The standalone CLI also refuses production mode. Existing backend CSP rules must allow the relay's module and WebSocket origin during development. This fixture tests direct cross-origin loading, not proxy integration.
