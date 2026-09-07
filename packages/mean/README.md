# @meanhq/mean

[Mean](https://mean.app) is visual handoff for humans and agents. Freeze or record your screen, annotate with gestures, and hand the finished session to a human or a coding agent.

This package connects your web app's development server to Mean. When you mark an element of your running app, the annotation also carries its component name and source file and line, so an agent can go straight to the code. It runs in development only and adds nothing to the page.

## Install

```sh
npm i --save-dev @meanhq/mean
```

Then connect your development server. Pick the one you use.

Vite:

```js
// vite.config.ts
import { mean } from '@meanhq/mean/vite';
export default defineConfig({ plugins: [mean()] }); // keep your existing plugins
```

Next 16.3 or later, HTTP only, Webpack or Turbopack:

```js
// next.config.mjs
import { withMean } from '@meanhq/mean/next';
export default withMean(nextConfig);
```

Other Node dev servers, such as webpack-dev-server, Rspack, Express or Koa:

```js
import { createServer } from 'node:http';
import { mean } from '@meanhq/mean/middleware';

const server = createServer(app);
const middleware = mean(server, {
  dev: process.env.NODE_ENV === 'development',
  origin: 'http://127.0.0.1:3000',
  root: process.cwd(),
});
app.use(middleware); // before your routes; put middleware.scriptTag in your dev HTML
```

Non-Node backends, such as Rails, Django or Go:

```sh
npx @meanhq/mean --origin http://127.0.0.1:8000
```

Add the printed script tag to your development template only. Component HMR keeps the connection; after a dev-server restart, reload the page. The [server fixtures](https://github.com/meanhq/mean/tree/main/fixtures) show a complete setup for every host.

## Output

An annotation on a Save button, as reported by `mean inspect`:

```json
{
  "frame": 1, "n": 1, "kind": "pin", "text": "Move this button",
  "points": [[0.25, 0.36]], "region": "f1-a1-region.png",
  "element": {
    "role": "button", "label": "Save",
    "component": "SaveButton",
    "chain": ["SaveButton", "Editor", "App"],
    "source": { "file": "src/SaveButton.tsx", "line": 18, "column": 5 },
    "framework": "react",
    "elementPath": "html > body > main > button:nth-of-type(1)"
  }
}
```

## Supported

| Framework | Component names | Source locations |
| --- | --- | --- |
| React | Yes | Yes, from the development JSX transform |
| Vue 3 | Yes | Yes, from the template transform |
| Svelte 5 | Nested components; the mounted root has no name | Yes, from the template transform |
| Plain HTML | No | Static markup served by Vite |

Source locations come from the development build and are exact. A name or a location is omitted when the framework does not expose it; neither is ever inferred.

## Privacy

Development only. Vite excludes the package from production builds; other servers keep it in development entry points.
Loopback only. The page connects to its own development server or to the standalone relay, which connects to Mean on 127.0.0.1.
Nothing leaves the machine. There are no remote requests, no telemetry and no account. Form values and editable text are never read.

## Troubleshooting

Run `mean doctor dom` and focus the development page when prompted. It reports the connection, the matched page and whether source metadata is available.
