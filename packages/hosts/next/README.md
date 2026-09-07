# Next

```js
// next.config.mjs
import { withMean } from '@meanhq/mean/next';
export default withMean(nextConfig);
```

Run your usual `next dev` command from the project root. No layout edit, custom server or second command is needed.

The host uses Next's client instrumentation injection, introduced in 16.3. It accepts object, promise and function configurations and preserves your instrumentation, webpack hooks, Turbopack rules and rewrites. Production phases return your configuration unchanged.

Mean opens its own ephemeral listener on 127.0.0.1 inside the dev process; no Mean request passes through Next. The page loads the runtime from that listener with an exact page-origin allowlist and the project page token.

## Limits

Only local HTTP origins work: `localhost`, `127.0.0.1` and `[::1]`, at the exact hostname and port Next prints. HTTPS, other hostnames, `basePath`, `assetPrefix`, custom servers and Next versions outside the 16.3-or-later Next 16 series disable Mean with one warning. The fixtures cover 16.3.4 only. After a dev-server restart, reload the page.

One listener per project is shared across config evaluations and workers through a lock under `node_modules/.cache/mean/next-<project-hash>`. If a dev process dies while holding the claim, Mean fails closed: stop the project's dev processes, remove `next-relay.claim` (and a stale `next-relay.json` if its PID was reused) and restart.

Source stamps cover JSX in `.js`, `.jsx` and `.tsx` files and name the JSX host element, not necessarily the component's definition. Source and component names can be absent independently.
