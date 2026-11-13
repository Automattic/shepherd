# Contributing

## Checks

```sh
bun run dev         # restarts the server when a file changes
bun run typecheck   # tsc --noEmit
bun run check       # typecheck, plus a bundle of the browser client
bun test            # unit tests (src/*.test.ts)
```

Run `bun run check` and `bun test` before you open a pull request.

## Layout

| Path | Role |
| --- | --- |
| `src/server.ts` | HTTP server (`Bun.serve`), routes, static files, and the browser bundle built at startup |
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

## Documentation

User-facing docs live in [`docs/`](docs). Keep the README to setup, a short tour and links; put detail in the matching doc. When a behavior changes, update the doc that describes it in the same pull request.
