# Contributing

## Checks

```sh
bun run dev         # restarts the server when a file changes
bun run typecheck   # tsc --noEmit
bun run check       # typecheck, plus a bundle of the browser client
bun test            # unit tests (src/*.test.ts)
bun run build:client  # writes a minified app.js, app.js.map, styles.css and index.html to dist/
```

Run `bun run check` and `bun test` before you open a pull request.

## Layout

| Path | Role |
| --- | --- |
| `src/server.ts` | HTTP server (`Bun.serve`), routes, static files, and the browser bundle built at startup |
| `src/build-client.ts` | Bundles the browser client, for the server at startup and for `bun run build:client` |
| `src/api-version.ts` | The client's check of the `apiVersion` that `/api/config` sends |
| `src/config.ts` | Loads and checks `config.json` |
| `src/gh.ts` | Runs `gh api` (GraphQL, plus REST GETs) with per-host concurrency caps and optional proxychains |
| `src/prs.ts` | List, detail and follow-up GraphQL queries, parsing (AI-review findings, Linear keys, participants) and caches |
| `src/mcp.ts` | The MCP endpoint and its tools |
| `src/waiting.ts` | What "waiting on" means, shared by the dashboard and the MCP tools |
| `src/base-age.ts` | How old a PR's base is, shared by the dashboard and the MCP tools |
| `src/merged.ts` | The Shipped ranges and filter, shared by the dashboard and the MCP tools |
| `src/followups.ts` | What counts as a follow-up: parses descriptions, reviews and comments |
| `src/herdr.ts` | Optional herdr integration: pane scan, PR matching and pane focus over herdr's socket |
| `src/types.ts` | Types shared by the server, the MCP endpoint and the browser client |
| `web/app.ts` | The dashboard client: no framework, bundled by Bun into `/app.js` |
| `public/` | `index.html` and `styles.css` |

The page loads Font Awesome 6.5.2 from cdnjs and the Geist fonts from Google Fonts. Everything else is local.

## Build the client for another host

A host that embeds the client can pin one Shepherd commit and run `bun run build:client`. The command writes `app.js`, `app.js.map`, `styles.css` and `index.html` to `dist/`. It uses the same `buildClient()` as the server, with the `minify` option. `app.js` and `styles.css` are minified, and `app.js` points to its source map in `app.js.map`. The server does not minify the client that it sends, and it puts the source map inline.

`index.html` loads `app.js` and `styles.css` with relative paths, so a host can serve `dist/` from any folder. The client sends its requests to absolute paths on the same origin: `/api/config`, `/api/prs`, `/api/pr`, `/api/merged`, `/api/followups`, `/api/herdr/links` and `/api/herdr/focus`. When the page has a token, each request has an `Authorization: Bearer <token>` header.

The host's API must send the same JSON shapes as `src/types.ts`, and `/api/config` must send the `apiVersion` of that commit. When `apiVersion` is missing or different, the page shows an error and no rows.

## API version

`API_VERSION` in `src/types.ts` is the version of the JSON shapes in that file. `/api/config` sends it as `apiVersion`.

Increase `API_VERSION` by 1 when a change in `src/types.ts` can break an old client or an old server. Examples:

- You remove or rename a field.
- You change the type or the meaning of a field.
- You make an optional field required in a request or a response.

Do not increase it when you add an optional field that old clients can ignore.

## Documentation

User-facing docs live in [`docs/`](docs). Keep the README to setup, a short tour and links; put detail in the matching doc. When a behavior changes, update the doc that describes it in the same pull request.
