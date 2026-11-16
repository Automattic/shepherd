# Contributing

## Checks

```sh
bun run dev         # restarts the server when a file changes
bun run typecheck   # tsc --noEmit
bun run check       # typecheck, plus a bundle of the browser client
bun test            # unit tests (src/*.test.ts)
bun run build:client  # writes a minified app.js, app.js.map, styles.css, index.html, queries.json and contract/ to dist/
```

Run `bun run check` and `bun test` before you open a pull request.

## Layout

| Path | Role |
| --- | --- |
| `src/server.ts` | HTTP server (`Bun.serve`), routes, static files, and the browser bundle built at startup |
| `src/build-client.ts` | Bundles the browser client, for the server at startup and for `bun run build:client`, which also writes `dist/queries.json` and `dist/contract/` |
| `src/queries.ts` | The GraphQL field sets and the list, merged and detail queries that are built from them; `dist/queries.json` holds the field sets |
| `src/contract.ts` | Checks the cases in `contract/cases/` and shapes each one with `createPrService()`, for `dist/contract/` |
| `contract/cases/` | One JSON file for each invented PR: the `data` of a detail query response. The input of the contract fixtures |
| `src/api-version.ts` | The client's check of the `apiVersion` that `/api/config` sends |
| `src/config.ts` | Loads and checks `config.json` |
| `src/gh.ts` | Runs `gh api` (GraphQL, plus REST GETs) with per-host concurrency caps and optional proxychains |
| `src/prs.ts` | The follow-up query, shaping of the list, detail and follow-up data (AI-review findings, Linear keys, participants) and caches |
| `src/mcp.ts` | The MCP endpoint and its tools |
| `src/waiting.ts` | What "waiting on" means, shared by the dashboard and the MCP tools |
| `src/base-age.ts` | How old a PR's base is, shared by the dashboard and the MCP tools |
| `src/merged.ts` | The Shipped ranges and filter, shared by the dashboard and the MCP tools |
| `src/repo-chips.ts` | Keys and labels of the repo chips when the config has no repos, used by the browser client |
| `src/followups.ts` | What counts as a follow-up: parses descriptions, reviews and comments |
| `src/herdr.ts` | Optional herdr integration: pane scan, PR matching and pane focus over herdr's socket |
| `src/embed.ts` | Options that a host page gives to the client in `window.SHEPHERD`: API base path, extra headers, mount element and header |
| `src/types.ts` | Types shared by the server, the MCP endpoint and the browser client |
| `web/app.ts` | The dashboard client: no framework, bundled by Bun into `/app.js` |
| `web/shell.ts` | The markup of the dashboard, which the client renders into the mount element |
| `public/` | `index.html` (only the mount element) and `styles.css` (scoped to `.shepherd`) |

The page loads Font Awesome 6.5.2 from cdnjs and the Geist fonts from Google Fonts. Everything else is local.

## Build the client for another host

A host that embeds the client can pin one Shepherd commit and run `bun run build:client`. The command writes `app.js`, `app.js.map`, `styles.css`, `index.html`, `queries.json` and a `contract/` folder to `dist/`. It uses the same `buildClient()` as the server, with the `minify` option. `app.js` and `styles.css` are minified, and `app.js` points to its source map in `app.js.map`. The server does not minify the client that it sends, and it puts the source map inline.

`index.html` loads `app.js` and `styles.css` with relative paths, so a host can serve `dist/` from any folder. By default, the client sends its requests to absolute paths on the same origin: `/api/config`, `/api/prs`, `/api/pr`, `/api/merged`, `/api/followups`, `/api/herdr/links` and `/api/herdr/focus`. A host page can send them to another path or URL with `apiBase` (see [Embedding](docs/embedding.md)). When the page has a token, each request to the same origin has an `Authorization: Bearer <token>` header.

The host's API must send the same JSON shapes as `src/types.ts`, and `/api/config` must send the `apiVersion` of that commit. When `apiVersion` is missing or different, the page shows an error and no rows.

### `queries.json` and `contract/`

A host that does not run this server's data layer, but ports it to another language, can use two more outputs of the build. Each build writes the same bytes for these two outputs, and the `dist/contract/` folder is deleted and written again, so a removed case leaves no file.

- `dist/queries.json` is `{ "apiVersion": <API_VERSION>, "fields": { "detailPr", "miniPr", "lightPr", "mergedPr" } }`. Each value is a GraphQL field set from `src/queries.ts`: `detailPr` is the selection of `pullRequest(number:$n)` in the detail query, `miniPr` is the selection of the `parent` and `stackedOnThis` nodes, `lightPr` is the selection of a PR in the open list search, and `mergedPr` is the selection of a PR in the merged search. The host builds its own queries from them, so it asks for the same fields as this server.
- `dist/contract/<case>.json` is `{ name, context, input, expected }`. `input` is a case from `contract/cases/`: the `data` of a detail query response for an invented PR, with the `host`, `owner`, `repo`, `number`, `head` and `base` of the request. `expected` is the `PrDetail` that `createPrService().getDetail()` returns for it. A host that ports the data layer can test its shaping against these files: give `input.data` to its own code, with `context`, and compare the result with `expected`.

Every file has the same `context`, which is also the config that produced `expected`: the hosts `ghe` (hostname `github.example.com`, AI-review bot `review-bot`) and `github` (hostname `github.com`, no bot), and Linear workspace `example` with no keys. There are no review teams and no ignored participants. A host has to map these hostnames and the bot login to its own before it compares.

Things in `expected` that a host does not shape from `input`:

- `fetchedAt` is a fixed time, `2000-01-01T00:00:00.000Z`.
- `baseAge` comes from a separate compare call, and the fixtures have none. For an open PR it holds the "unknown" object with `error: "compare not available in contract"`, as this server does when its compare call fails. For a merged or a closed PR it is null.

The contract covers the detail shape (`PrDetail`) only. It does not cover the list or the merged shapes. To add a case, add `contract/cases/<name>.json`, where `<name>` is the file name, and run `bun test`. The tests check that each case has every field that the detail query asks for and no other, and that the cases together have a value for every field.

## API version

`API_VERSION` in `src/types.ts` is the version of the JSON shapes in that file. `/api/config` sends it as `apiVersion`. The client accepts only the `API_VERSION` that it was built with. It does not accept a range of versions.

Increase `API_VERSION` by 1 when a change in `src/types.ts` can break an old client or an old server. Examples:

- You remove or rename a field.
- You change the type or the meaning of a field.
- You make an optional field required in a request or a response.

Do not increase it when you add an optional field that old clients can ignore.

## Documentation

User-facing docs live in [`docs/`](docs). Keep the README to setup, a short tour and links; put detail in the matching doc. When a behavior changes, update the doc that describes it in the same pull request.
