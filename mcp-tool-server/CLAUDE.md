# MCP Tool Server

The original draw.io MCP server. Opens diagrams directly in the draw.io editor via browser.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.js` | Single-file server (stdio transport, vanilla JS, no build step) |
| `src/libavoid-pass.js` | Server-side libavoid edge-routing pass for `open_drawio_xml` (`routing: "libavoid"`) — parses the mxGraphModel XML, runs the vendored routing core (`AvoidRouting.computeRoutes`), writes waypoints back |
| `src/pages.js` | Local `.drawio` file page access for `list_pages`/`get_page`/`set_page` — regex-scans `<diagram>` blocks (same tag-boundary technique as `libavoid-pass.js`), decompresses/compresses per-page with `pako` as needed. Covered by `test/pages.test.js` (`npm test`) |
| `vendor/libavoid/` | Vendored libavoid-js **node** build + `libavoid.wasm` (see its README). Loaded by path in plain Node — no inlining/base64 (that's the app server's sandbox concern) |

## Tools

### `open_drawio_xml`

Opens draw.io with native XML content. Full control over styling and positioning.

**`routing: "libavoid"`** (optional) runs an obstacle-avoiding orthogonal edge-routing pass server-side before the URL is built: vertices stay put, connectors are recomputed to route *around* shapes in clean right angles (draw.io's built-in router has no obstacle avoidance). The routing math is `AvoidRouting.computeRoutes` from the vendored `vendor/libavoid/libavoid-routing.js` — a verbatim copy of the canonical `drawio-dev js/libavoid-js/libavoid-routing.js`, identical to the app server's and the draw.io editor's. Fails safe — any parse/route issue returns the original XML unrouted.

### `open_drawio_csv`

Opens draw.io with CSV data converted to a diagram. Useful for org charts, but CSV processing can fail — prefer Mermaid when possible.

**Avoid** using `%column%` placeholders in style attributes (like `fillColor=%color%`) — causes "URI malformed" errors.

### `open_drawio_mermaid`

Opens draw.io with Mermaid.js syntax. **Recommended default** — handles flowcharts, sequences, ER diagrams, Gantt charts, and more reliably.

### `search_shapes`

Searches the draw.io shape library (~10,000 shapes) by keywords and returns matching shapes with their exact `style` strings, dimensions, and titles — for feeding industry-specific icons (AWS, Azure, GCP, Cisco, Kubernetes, P&ID, electrical, BPMN) into `open_drawio_xml`. The algorithm is the shared `buildTagMap`/`searchShapes` (canonical in `shared/shape-search.js`, copied into `src/` by `copy-shared`), identical to the app server's.

When the local index has no strong match for a query (no result exact-matched every term), results are supplemented live from the draw.io icon service (`icons.diagrams.net` — brand logos and general-purpose concept icons, returned as `shape=image` styles referencing the remote SVG). The merge pipeline is `searchShapesAndIcons` (canonical in `shared/icon-search.js`, also copied by `copy-shared`; covered by `test/icon-search.test.js`): strong local results lead and icons only fill spare slots; weak (Soundex/OR-fallback) local results keep at most half the budget. A full page of strong local results makes no network request; a service failure degrades to local-only results. Override the endpoint with `DRAWIO_ICON_SERVICE_URL` (a self-hosted service base URL, or `off` to disable icon supplementation).

To keep the npm package lean, the ~4.6 MB `search-index.json` is **not** bundled. It is loaded lazily on the **first** `search_shapes` call and cached in memory for the process lifetime; the tag lookup map is built once at that point. An in-repo checkout reads the local `shape-search/search-index.json` (so dev and tests need no network); a published install fetches it from the CDN (`https://cdn.jsdelivr.net/gh/jgraph/drawio-mcp@main/shape-search/search-index.json`, overridable via `DRAWIO_SHAPE_INDEX_URL`). The tool is always advertised; if the index can't be loaded, the call returns a clear error instead of the tool being hidden.

### `list_pages` / `get_page` / `set_page`

Local-file, page-level access for large multi-page `.drawio` files, so an LLM doesn't have to load the whole file into context to inspect or edit one page.

- **`list_pages(path)`** — returns `[{index, id, name, approxSizeBytes}]` for every `<diagram>` in the file. Regex-scans tag boundaries only; never decompresses page bodies, so it stays cheap even for large files.
- **`get_page(path, page)`** — returns the raw `mxGraphModel` XML for one page (`page` is a zero-based index, the page's exact `name`, or its `id`), decompressing it first if that page is stored compressed.
- **`set_page(path, page, content)`** — replaces one page's content with new `mxGraphModel` XML (`content`), re-compressing to match that page's original compression state. Every other page, and the rest of the file, is left byte-for-byte untouched.

Draw.io stores each `<diagram>` body as either plain `mxGraphModel` XML or a base64(`pako.deflateRaw`) blob, independently per page — `src/pages.js` detects which per page (body starts with `<` vs. not) rather than trusting the outer `<mxfile compressed="...">` attribute, since files can mix compression states across pages. Duplicate page names are resolved by erroring with the ambiguous indices rather than guessing (use the index or `id` instead; a page whose name is all digits is parsed as an index, so address it by `id`).

These are the only tools whose arguments touch the local filesystem, so they are deliberately constrained: paths must end in `.drawio` or `.xml` (checked before existence, so arbitrary paths aren't probed); `set_page` content must be a single `<mxGraphModel>` element and is rejected if it contains raw `<diagram>` tags (which would escape the page body and rewrite the file's page structure); decompression is capped at 64 MB against deflate bombs; writes go through a temp file + rename so a crash can't truncate the target. Self-closing `<diagram/>` pages (empty pages) are handled on both read and write.

## URL Generation

1. Content is encoded with `encodeURIComponent`
2. Compressed using pako `deflateRaw`
3. Encoded as base64
4. Wrapped in a JSON object: `{ type, compressed: true, data }`
5. Appended to the draw.io URL as `#create={...}`

## Quick Decision Guide

| Need | Use | Reliability |
|------|-----|-------------|
| Flowchart, sequence, ER diagram | `open_drawio_mermaid` | High |
| Custom styling, precise positioning | `open_drawio_xml` | High |
| Org chart from data | `open_drawio_csv` | Medium |

## XML Reference

The `open_drawio_xml` tool description is loaded at startup from `shared/xml-reference.md` (single source of truth for all prompts). The `copy-shared` script (run on `prestart` and `prepack`) copies it — plus `shared/mermaid-reference.md`, `shared/shape-search.js`, and `shared/icon-search.js` — into `src/` so the npm package is self-contained. These copies are gitignored; the `search_shapes` loader imports the helper from the local copy with a fallback to `../../shared/` for in-repo runs. (The libavoid routing core is NOT part of copy-shared — it lives in `vendor/libavoid/libavoid-routing.js`, synced from drawio-dev. The ~4.6 MB `search-index.json` is deliberately **not** copied/bundled — it is fetched at runtime; see `search_shapes` above.)

## Coding Conventions

- **Allman brace style**: Opening braces go on their own line for all control structures, functions, objects, and callbacks.
- Prefer `function()` expressions over arrow functions for callbacks.
- See the root `CLAUDE.md` for examples.

## Development

```bash
npm install
npm start
```

Published as `@drawio/mcp` on npm. Run with `npx @drawio/mcp`.
