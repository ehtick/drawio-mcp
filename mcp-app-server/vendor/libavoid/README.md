# libavoid (app server) — loaded from the CDN

Obstacle-avoiding orthogonal **edge routing** (the `routing: "libavoid"`
pass). Since the draw.io release that ships the pure-JS two-file
`js/libavoid-js/` layout on `viewer.diagrams.net`, the viewer HTML loads
libavoid from the CDN like drawio-elk and drawio-mermaid — nothing is
vendored here anymore:

```html
<script src="https://viewer.diagrams.net/js/libavoid-js/libavoid.min.js"></script>
<script src="https://viewer.diagrams.net/js/libavoid-js/libavoid-routing.js"></script>
```

(pure-JS router bundle → shared routing core; see `buildHtml`'s
`libavoidBlock` in `src/shared.js`, ETag-versioned URLs from
`src/libavoid-versions.js`). `libavoid.min.js` is the pure-JS Emscripten
build — a self-contained classic script, **no WASM and no `fetch`**, so the
sandboxed iframe (no `allow-same-origin`, no `data:` in `connect-src`) is
satisfied by plain `script-src` — no `'wasm-unsafe-eval'` needed. On
execution it publishes `globalThis.Avoid` and synchronously parks
`window.__libavoidReady` (an already-resolved promise: the `Avoid`
namespace, or `null` on an init failure); the routing core defines
`globalThis.AvoidRouting` — the same canonical `drawio-dev js/libavoid-js/`
artifact the draw.io editor bundles and the mcp-tool-server vendors
(`mcp-tool-server/vendor/libavoid/`, which stays vendored: it runs
server-side in Node and ships in the npm package).

`buildHtml` still supports inlining a local build instead (pass
`options.libavoidJs` — the drawio-dev `libavoid.min.js` artifact as-is, with
`libavoid-routing.js` appended), e.g. for testing unreleased libavoid
changes.

Remaining files:

- `libavoid.d.ts` — TypeScript typings for the `Avoid` API
  (`Router`, `ShapeRef`, `ConnRef`, `ConnEnd`, `Rectangle`, `Point`,
  `displayRoute()`, `processTransaction()`, routing parameters/options) —
  kept as a dev reference for the viewer-side routing code in `shared.js`.
- `LICENSE` — libavoid-js is LGPL-2.1-or-later (kept for reference; the
  binaries are served by the CDN, not shipped from this repo).

> ⚠️ The host CSP must allow `viewer.diagrams.net` in `script-src` — the
> same allowance drawio-elk/drawio-mermaid already rely on.
