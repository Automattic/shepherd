# Contributing

## Checks

```sh
bun run dev         # restarts the server when a file changes
bun run typecheck   # tsc --noEmit
bun run check       # typecheck, plus a bundle of the browser client
bun test            # unit tests (src/*.test.ts)
bun run build:client  # writes a minified app.js, app.js.map, styles.css, index.html, queries.json, settings.schema.json and contract/ to dist/
```

Run `bun run check` and `bun test` before you open a pull request.

## Layout

| Path | Role |
| --- | --- |
| `src/server.ts` | HTTP server (`Bun.serve`), routes, static files, and the browser bundle built at startup |
| `src/build-client.ts` | Bundles the browser client, for the server at startup and for `bun run build:client`, which also writes `dist/queries.json` and `dist/contract/` |
| `src/queries.ts` | The GraphQL field sets, the list and merged queries, the template of the batch detail query (`BATCH_TEMPLATE`) and the builder that joins it (`buildDetailBatch()`); `dist/queries.json` holds the field sets, the queries and the template |
| `src/contract.ts` | Checks the cases in `contract/cases/` and shapes each one with `createPrService()`, for `dist/contract/` |
| `contract/cases/` | One JSON file for each invented PR: the `data` of a batch detail query response (`pr0`, `dn0`, `up0`). The input of the contract fixtures |
| `src/api-version.ts` | The client's check of the `apiVersion` that `/api/config` sends |
| `src/config.ts` | Loads and checks `config.json`; `problems()` uses the settings schema |
| `src/settings-schema.ts` | The settings schema: the one set of rules for `config.json` and `PUT /api/settings`, written to `dist/settings.schema.json` |
| `src/schema.ts` | A small validator for the JSON Schema subset that the settings schema uses |
| `src/settings.ts` | The settings model: `config.json` to personal and deployment settings, field metadata, and the checks of `PUT /api/settings` |
| `src/settings-store.ts` | `config.json` as settings storage: reload on change, conflict check, and safe writes |
| `src/settings-api.ts` | `GET` and `PUT /api/settings` on the local server |
| `src/settings-transfer.ts` | The settings file of the panel's Export and Import, and how an import fits it to another server |
| `src/review-bot.ts` | Which login is the AI-review bot of a PR: the host's `botsByOwner` entry for the owner, or the host's `bot` |
| `src/linear.ts` | The pattern for Linear ticket keys, with each key matched as plain text |
| `src/gh.ts` | Runs `gh api` (GraphQL, plus REST GETs) with per-host concurrency caps and optional proxychains |
| `src/prs.ts` | The follow-up query, shaping of the list, detail and follow-up data (AI-review findings, Linear keys, participants), caches, and the batched fetching of details (`getDetails()`, `prefetchDetails()`) |
| `src/mcp.ts` | The MCP endpoint and its tools |
| `src/waiting.ts` | What "waiting on" means, shared by the dashboard, the MCP tools and `/api/queue` |
| `src/ready.ts` | What keeps an approved PR from going out, used by the dashboard |
| `src/base-age.ts` | How old a PR's base is, shared by the dashboard and the MCP tools |
| `src/merged.ts` | The Shipped ranges and filter, shared by the dashboard and the MCP tools |
| `src/repo-scope.ts` | Which repos each host searches: the listed repos, its `anyRepo` orgs or its `defaultOrgs`; the search qualifiers, and the check that the follow-ups endpoint and the MCP tools use |
| `src/repo-chips.ts` | Keys and labels of the repo chips for repos that the config does not list, the repos that "Add more repos" offers, and how a saved repo filter follows a repo into or out of the list; used by the browser client |
| `src/followups.ts` | What counts as a follow-up: parses descriptions, reviews and comments |
| `src/herdr.ts` | Optional herdr integration: pane scan, PR matching and pane focus over herdr's socket |
| `src/embed.ts` | Options that a host page gives to the client in `window.SHEPHERD`: API base path, extra headers, mount element, header, theme, and the host's own top bar and gate content |
| `src/types.ts` | Types shared by the server, the MCP endpoint and the browser client |
| `web/app.ts` | The dashboard client: no framework, bundled by Bun into `/app.js` |
| `web/shell.ts` | The markup of the dashboard, which the client renders into the mount element |
| `web/settings.ts` | The settings panel, which edits the personal settings through `/api/settings` |
| `public/` | `index.html` (only the mount element) and `styles.css` (scoped to `.shepherd`) |

The page loads Font Awesome 6.5.2 from cdnjs and the Geist fonts from Google Fonts. Everything else is local.

## Build the client for another host

A host that embeds the client can pin one Shepherd commit and run `bun run build:client`. The command writes `app.js`, `app.js.map`, `styles.css`, `index.html`, `queries.json`, `settings.schema.json` and a `contract/` folder to `dist/`. It uses the same `buildClient()` as the server, with the `minify` option. `app.js` and `styles.css` are minified, and `app.js` points to its source map in `app.js.map`. The server does not minify the client that it sends, and it puts the source map inline.

`index.html` loads `app.js` and `styles.css` with relative paths, so a host can serve `dist/` from any folder. By default, the client sends its requests to absolute paths on the same origin: `/api/config`, `/api/prs`, `/api/pr`, `/api/merged`, `/api/followups`, `/api/herdr/links`, `/api/herdr/focus` and `/api/settings`. A host page can send them to another path or URL with `apiBase` (see [Embedding](docs/embedding.md)). When the page has a token, each request to the same origin has an `Authorization: Bearer <token>` header.

The host's API must send the same JSON shapes as `src/types.ts`, and `/api/config` must send the `apiVersion` of that commit. When `apiVersion` is missing or different, the page shows an error and no rows.

`dist/settings.schema.json` is the settings schema from `src/settings-schema.ts`. A host that keeps settings in its own storage checks each `PUT /api/settings` with it, so its rules stay the same as this server's. See [Settings](docs/embedding.md#settings).

### `queries.json` and `contract/`

A host that does not run this server's data layer, but ports it to another language, can use two more outputs of the build. Each build writes the same bytes for these two outputs, and the `dist/contract/` folder is deleted and written again, so a removed case leaves no file.

- `dist/queries.json` is `{ "format": 2, "apiVersion": <API_VERSION>, "fields": { "detailPr", "miniPr", "lightPr", "mergedPr" }, "queries": { "search", "merged", "batch", "examples" } }`. `queriesJson()` in `src/queries.ts` makes it. `format` is the version of the layout of this file and of the `contract/` files: raise it when a part is renamed or removed, a joining rule changes, the meaning of an alias or of a `when` value changes, or the shape of a contract file changes (adding a field to a field set does not raise it). The `fields` are GraphQL field sets: `detailPr` is the selection of a PR in the batch detail query, `miniPr` is the selection of the PRs that are stacked on it and the PR that it is stacked on, `lightPr` is the selection of a PR in the open list search, and `mergedPr` is the selection of a PR in the merged search. `queries.search` and `queries.merged` are the complete list and merged queries, which a host sends as they are. `queries.batch` is `BATCH_TEMPLATE`: the parts of the detail query for 1 to `BATCH_MAX` (10) PRs of one repository, which `buildDetailBatch()` joins and a host joins with the rules in [docs/embedding.md](docs/embedding.md#queriesjson). `queries.examples` has three fixed inputs of the builder, with the exact query text and variables that it builds. A host has no GraphQL text of its own, and it tests its expansion against the examples.
- `dist/contract/<case>.json` is `{ name, context, input, expected }`. `input` is a case from `contract/cases/`: the `host`, `owner` and `repo`, the `prs` of the batch query (one PR: `number`, `head` and `base`), and the `data` of the batch response for an invented PR (`data.repository.pr0`, `dn0` and `up0`, `defaultBranchRef`, and `data.rateLimit`). `expected` is the `PrDetail` that `createPrService().getDetail()` returns for it. A host that ports the data layer can test its shaping against these files: give `input.data` to its own code, with `context`, and compare the result with `expected`.

The batch detail query has one `pr<i>` alias for each PR, a `dn<i>` alias (the PRs stacked on it) when the PR has a head branch, and an `up<i>` alias (the PR it is stacked on) when its base is not a default branch. `src/queries.ts` has the template and the builder, and nothing else builds a detail query: `getDetail()` in `src/prs.ts` sends a batch of one, `getDetails()` sends the PRs of a repository `BATCH_MAX` (10) to a query for the MCP tools, and `prefetchDetails()` does the same in the background for the PRs of a list call (see [Fetching details in batches](docs/refreshing.md#fetching-details-in-batches)). Names, numbers and branches reach GitHub only as variables, and the query text depends only on the number of PRs and on which PRs have a head and a stacked base. To change the query, change `BATCH_TEMPLATE` or a field set, and run `bun test`: the goldens in `src/queries.test.ts` are the same text as `queries.examples`, so they show the change.

Every file has the same `context`, which is also the config that produced `expected`: the hosts `ghe` (hostname `github.example.com`, AI-review bot `review-bot`) and `github` (hostname `github.com`, no default bot, but `other-review-bot` for the org `example-other-org` through `botsByOwner`), and Linear workspace `example` with no keys. There are no review teams and no ignored participants. A host has to map these hostnames, the org and the bot logins to its own before it compares.

Things in `expected` that a host does not shape from `input`:

- `fetchedAt` is a fixed time, `2000-01-01T00:00:00.000Z`.
- `baseAge` comes from a separate compare call, and the fixtures have none. For an open PR it holds the "unknown" object with `error: "compare not available in contract"`, as this server does when its compare call fails. For a merged or a closed PR it is null.

The contract covers the detail shape (`PrDetail`) only. It does not cover the list or the merged shapes. To add a case, add `contract/cases/<name>.json`, where `<name>` is the file name, and run `bun test`. The tests check that each case is a batch response (`pr0`, `dn0`, and `up0` only when the base is not a default branch), that it has every field that the detail query asks for and no other, and that the cases together have a value for every field. The shaping treats an actor as a bot when its `__typename` is `Bot`, so a case can have a bot with no `[bot]` suffix (the case `bot-typed-actor`).

## API version

`API_VERSION` in `src/types.ts` is the version of the JSON shapes in that file. `/api/config` sends it as `apiVersion`. The client accepts only the `API_VERSION` that it was built with. It does not accept a range of versions.

Increase `API_VERSION` by 1 when a change in `src/types.ts` can break an old client or an old server. Examples:

- You remove or rename a field.
- You change the type or the meaning of a field.
- You make an optional field required in a request or a response.

Do not increase it when you add an optional field that old clients can ignore.

## Documentation

User-facing docs live in [`docs/`](docs). Keep the README to setup, a short tour and links; put detail in the matching doc. When a behavior changes, update the doc that describes it in the same pull request.
