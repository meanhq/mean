# Changelog

## Unreleased

- cooperative, cumulative page walk: the first `walk.result` part targets 20 ms of page time, later parts follow 12 ms slices on zero-delay timers until the page is covered; parts carry `part` and `more`, only the final part reports `truncated`
- whole-walk caps of 4000 elements, 40000 inspections, 2 MiB and 2 s replace the single 1000-element, 256 KiB prefix; each part stays under 256 KiB
- a pending walk is closed by a new probe or walk and by page hide; no timer exists outside an in-flight walk
- a rounded overflow container clips its descendants to its padding box inset by its largest corner radius; only a transformed overflow container keeps its own rectangle while its descendants are omitted
- a page change after the first part closes the walk with a final truncated part instead of `stale`
- Vite 8 accepted as a peer (`^7.0.0 || ^8.0.0`), with a `vite8-dom` fixture
- cheaper per-element work: no code point scan for short strings, own-key React fibre lookup, one shared text encoder

## 0.1.0

Unreleased.

- shared browser runtime, Node relay, host integrations and source stampers
- Vite source stamping for JSX, static HTML, Vue templates and Svelte templates
- React, Vue and Svelte component metadata, with source independent of names
- middleware fixtures for Webpack, Rspack, Express and Koa
- standalone loopback relay for non-Node development pages with an explicit origin allowlist
- `withMean` for Next 16.3.4 over HTTP, on Webpack and Turbopack with both routers
- private per-project tokens and a stable standalone port, with explicit rotation and port changes
