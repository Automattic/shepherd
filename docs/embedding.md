# Embedding the client in another page

The dashboard client (`app.js`) can run in a page that another app serves. That app usually has its API at a different path, uses its own authentication, and has its own header. To tell the client about it, set `window.SHEPHERD` before `app.js` loads:

```html
<div id="shepherd"></div>
<script>
	window.SHEPHERD = {
		mount: '#shepherd',              // the element that gets the dashboard
		header: false,                   // no Shepherd brand header
		apiBase: '/my-app/api/shepherd', // replaces the "/api" prefix
		headers: { 'X-Nonce': '…' },     // added to every API call
	};
</script>
<script src="app.js" type="module"></script>
```

The client reads the object one time, when it starts. Changes to the object after that have no effect.

## Options

| Key | Purpose |
| --- | --- |
| `apiBase` | Replaces the `/api` prefix of every API call. For example, `/api/prs?reviewers=…` goes to `/my-app/api/shepherd/prs?reviewers=…`. Use a path on the same origin (it starts with one `/`) or a URL that starts with `http://` or `https://`. A URL on a different origin needs CORS on that server. The client removes a trailing `/`. |
| `headers` | An object of header names and string values. The client adds them to every API call. The browser does not send some headers that a page sets, for example `Cookie`, `Host`, `Origin`, `Referer` and the names that start with `Sec-` or `Proxy-`. Use other names. |
| `mount` | The element that gets the dashboard: a CSS selector or an element. The default is `#shepherd`. The client replaces the content of the element. When no element matches, the client stops with an error in the browser console. |
| `apiTrailingSlash` | `true` adds a `/` to the end of the path of each call to `apiBase`, before the query. For example, `/api/prs?reviewers=…` goes to `/my-app/api/shepherd/prs/?reviewers=…`. Use it when the host redirects a path without the slash: each redirect costs one more request, and a browser changes a redirected `POST` to a `GET`. It has no effect without `apiBase`. The default is `false`. |
| `header` | `false` removes the brand header (the logo, the name and the line below it). The controls (the rate budget, the refresh interval, **Refresh now**, the theme button, the settings button and the note of a team or member view) stay in a bar at the top of the dashboard. This bar does not stick to the top of the window. The default is `true`. |

The host's API must give the same responses as the paths below on the local server:

- `/api/config`
- `/api/prs`
- `/api/pr`
- `/api/merged`
- `/api/followups`
- `/api/herdr/links` and `/api/herdr/focus` (only when herdr is on)
- `/api/settings` (only when `/api/config` sends `"features": { "settings": true }`; see [Settings](#settings))

`/api/config` must also send `mode` (see [Team and member views](#team-and-member-views)).

The local server answers `POST /api/herdr/*` only for a page on `localhost`, `127.0.0.1` or `[::1]`, or for a request with no `Origin` header. A page on another origin that calls the local server directly gets an error for these two paths.

## A host that ports the data layer

A host that gives the client its own API usually builds the `/api/pr` and `/api/prs` data itself, from GitHub. `bun run build:client` writes two more files for it to `dist/`, so that its GraphQL and its shaping stay the same as this server's:

- `queries.json` is `{ "format": 2, "apiVersion": <API_VERSION>, "fields": { "detailPr", "miniPr", "lightPr", "mergedPr" }, "queries": { "search", "merged", "batch", "examples" } }`. The `fields` are GraphQL field sets, and `queries` has the query texts and templates that this server sends. A host builds every query that it sends to GitHub from this file, and has no GraphQL text of its own. See [queries.json](#queriesjson) below.
- `contract/<case>.json` is `{ name, context, input, expected }`. `input` has the `host`, `owner` and `repo`, the `prs` of the batch query (one PR: its `number`, `head` and `base`), and the `data` of the batch response for an invented PR: `data.repository.pr0`, `dn0`, `up0` and `defaultBranchRef`, and `data.rateLimit`. `expected` is the `PrDetail` that this server's `getDetail()` shapes from it. A host can test its own shaping against these files: shape `input.data` with `context`, and compare the result with `expected`.

The `context` is the same in every file: the hosts `ghe` (hostname `github.example.com`, AI-review bot `review-bot`) and `github` (hostname `github.com`, no bot, but `other-review-bot` for the org `example-other-org`, which the case `org-review-bot` uses), and Linear workspace `example` with no keys, without review teams or ignored participants. `fetchedAt` is the fixed time `2000-01-01T00:00:00.000Z`. `baseAge` needs a compare call that the fixtures do not have, so for an open PR it is the "unknown" object with `error: "compare not available in contract"`, and for a merged or closed PR it is null. The contract covers the detail shape only, not the list or the merged shapes. See [Contributing](../CONTRIBUTING.md#queriesjson-and-contract) for how the files are made.

An actor is a bot when its `__typename` is `Bot`, or when its login has the suffix `[bot]` or `-bot`, starts with `app/`, or is an AI-review bot of any host (a `bot` or a `botsByOwner` value) or an ignored participant. The AI-review summary (`bot`) counts the threads of the PR's own bot: the host's `botsByOwner` entry for the repo's owner, matched without case, or else the host's `bot` (`src/review-bot.ts`). A GitHub App such as `github-actions` has no suffix, so only its type says that it is a bot. The shaping leaves a bot out of `participants` and `lastActivity`. The case `bot-typed-actor` has such an actor.

### queries.json

- `format` is the version of the layout of `queries.json` and of the shape of the `contract/` files. This server writes `2`. A host reads `format` first, and refuses any other value (a file without `format` is format 1), before it sends a request. `format` goes up when a part is renamed or removed, when a joining rule changes, when the meaning of an alias or of a `when` value changes, or when the shape of a contract file changes. Adding a field to a field set does not raise it. `apiVersion` is the version of the API types, and a host stops when it is not the version that the host was written for.
- `fields` are the GraphQL field sets. Each one is a bare selection body, with no outer braces, no variables and no aliases. `detailPr` is the selection of a PR in the batch detail query, `miniPr` is the selection of the PRs that are stacked on it and the PR that it is stacked on, `lightPr` is the selection of a PR in the open list search, and `mergedPr` is the selection of a PR in the merged search. A host that builds a query of its own around a field set puts it in a selection on `PullRequest`. `detailPr` has `avatarUrl(size: 64)` on the author, the requested users, the reviewers and the participants, and `__typename` on the people who comment, review and write the first comment of a thread, so a host needs no fields of its own.
- `queries.search` and `queries.merged` are complete queries (variables `$q` and `$after`). A host sends them as they are.
- `queries.batch` has the parts of the detail query for 1 to `max` PRs of one repository. A host joins them with the rules below.
- `queries.examples` has fixed inputs of the batch query, with the exact `query` text and the `variables` that this server builds for each. A host tests its own expansion against them.

#### The parts of `queries.batch`

| Part | Content |
| --- | --- |
| `max` | The most PRs of one repository in one query (10). A host sends a longer list in several queries, and each query has PRs of one repository only. |
| `defaultBranches` | The names of the branches that have no parent PR (`trunk`, `main`, `master`, `develop`). |
| `query` | The outer query text, with the placeholders `<vars>`, `<aliases>` and `<fragments>`. Each one appears exactly once. |
| `perPr` | A list of entries for each PR: `when`, `name`, `value`, `decl` and `alias`. The `decl` text is a variable declaration, and the `alias` text is a field of `repository`. `name`, `decl` and `alias` have `<i>` where the index of the PR goes. |
| `fragments` | A list of entries, `when` and `text`. The `text` is a fragment definition. |

The `when` of a `perPr` entry is `always`, `head` or `parentBase`. The `when` of a fragment is `always` or `stacks`. The `value` of a `perPr` entry is `number`, `head` or `base`.

#### The joining rules

1. Input: `owner`, `name` and `prs`, with 1 to `max` entries. Each entry is `{ number: integer ≥ 1, head: string, base: string }`. The PRs keep their input order. `i` is the 0-based index, written in decimal.
2. For each PR `i`, then for each `perPr` entry in array order, check whether its `when` holds:
   - `always`: always true.
   - `head`: `head !== ""`.
   - `parentBase`: `base !== ""`, and `base` is not in `defaultBranches`. The match is exact and case-sensitive.
3. For each entry that holds, replace every `<i>` in `name`, `decl` and `alias` with `i`. Append `decl` to V and `alias` to A, and set `variables[name]` to the input field `value`. `number` is a JSON integer (PHP: cast to `(int)`), because GitHub rejects the string `"123"` for `Int!`. The order is by PR first, then by entry. V and A start empty, and the join adds no separator of its own: each `decl` starts with `, `, and each `alias` starts with a newline and two tabs.
4. F is the concatenation, in array order, of the `text` of the `fragments` whose `when` holds. Each `text` ends with a newline, and the join adds no separator of its own.
   - `always`: always true.
   - `stacks`: at least one PR had a `head` or `parentBase` entry that held. A fragment that no alias uses is a GraphQL error, so this condition must be exact.
5. Replace `<vars>`, `<aliases>` and `<fragments>` in `query` with V, A and F. Each placeholder appears exactly once. The substitution is literal and single-pass, and the inserted text is not scanned again. TypeScript: `split` and `join`, or a function replacer, never a string replacer (`$&` and `$'` in a replacement string are patterns). PHP: one `strtr($query, [...])` call (chained `str_replace` calls scan the inserted text again).
6. `variables` holds `owner` and `name`, then the entries of step 3. Compare variables as JSON objects: the order of the keys does not matter, and the order of the declarations in the query text does.
7. The response has `repository.pr<i>` for the PR, `repository.dn<i>` for the PRs that are stacked on it (the `nodes`), `repository.up<i>.nodes[0]` for the PR that it is stacked on, and `repository.defaultBranchRef` and `rateLimit`. A PR with no `up<i>` has no parent lookup. A `pr<i>` that is `null`, or a `repository` that is `null`, means that the PR is not found (GitHub also answers `null` for a PR that it could not read), and the other PRs of the batch are not affected. A `dn<i>` or `up<i>` that is absent or `null` means that the PR has no stack links: no PRs stacked on it, or no parent. If an alias prefix or the meaning of a `when` value changes, `format` goes up.
8. A host checks the file when it loads it, and refuses the file when any of these is false:
   - every `when` value belongs to the closed set above, and every `value` is one of `number`, `head` and `base`;
   - `query` contains each placeholder exactly once;
   - every `name`, `decl` and `alias` contains `<i>`;
   - no field set contains `<`;
   - `max` is an integer ≥ 1;
   - `defaultBranches` is a list of strings.

Names, numbers and branches reach GitHub only as variables. They are never part of the query text, so the text depends only on the number of PRs, on which PRs have a head, and on which PRs have a base that is not a default branch.

#### The examples

Each entry of `queries.examples` is `{ name, input, query, variables }`. `input` is the input of step 1, and `query` and `variables` are the result of steps 2 to 6 for it. There are three: one PR into a default branch, one PR that is stacked on another PR (it has `dn` and `up`), and a batch of three PRs with a mix of default and other bases. A host expands each `input` with its own code, and checks that it gets the same `query` text byte for byte and the same `variables` (the numbers are JSON integers).

## Settings

A host can give each viewer their own settings: the team, repos, review teams, Linear and features. The client edits them in its settings panel, through two calls. The host keeps the settings in its own storage. `src/types.ts` has the shapes.

- `GET /api/settings` sends a `SettingsResponse`: `personal` and `deployment` (the values), `version`, `mode`, `fields` and, optionally, `problems`.
- `PUT /api/settings` gets a `SettingsPutRequest`: `{ "version": "…", "personal": { … }, "deployment"?: { "hosts": { … } } }`. `personal` has all six keys (`me`, `team`, `repos`, `reviewTeams`, `linear`, `features`); refuse a request that leaves one out, so a missing key never deletes a setting. The client sends `deployment.hosts` only when `fields` makes a host field editable; a host that locks `/deployment` refuses a change to it as `not_editable`. Each host in `deployment.hosts` can have `proxied: true` when it goes through proxychains; the path itself is never sent. It sends the new `SettingsResponse` when it saves. Otherwise it sends a `SettingsErrorResponse`: `{ "error", "errors": [ { "path", "code", "message" } ] }`.

| Status | When |
| --- | --- |
| 400 | The body is not a settings request. |
| 409 | `version` is not the current version, because another tab or another program saved first. Add the current settings as `settings`. The panel offers to load them. |
| 422 | One or more fields are refused. Each entry of `errors` names its field with a JSON pointer into the request (`/personal/repos/2`), so the panel shows the message at that field. |

The `code` of each error:

- `invalid`: the value breaks the settings schema.
- `not_editable`: the field is not editable for this viewer.
- `limit`: the value is over a cost limit, for example too many repos.
- `refused`: the host refuses a value with the right shape. For example, the viewer may not watch that repo. Use it for any check that the schema cannot make.

`fields` maps JSON pointers to `{ "editable": boolean, "reason"?: string }`. A `*` segment matches any item, and the longest matching pointer wins. A pointer with no match is editable under `/personal` and not editable under `/deployment`. Check a lock at each place it names, not as a list of values: an item of `team` is the same item when its `id` is the same, wherever it is in the array, and an error names the concrete field (`/personal/team/1/pushPolicy`). Send `{ "editable": false }` for the whole of `/deployment` when the viewer cannot change it, and for each feature that the host does not have (for example `/personal/features/herdr`). The panel shows these fields read-only, with the `reason`. The host must also refuse a change to them in `PUT`, because a request can send it anyway.

Push policies are personal settings like the others: a viewer can set the `pushPolicy` of anyone in their `team` and the `pushPolicyByAuthor` entries of their repos. A host that keeps each person's policy in one place, set only by that person, sends `{ "editable": false }` for `/personal/team/*/pushPolicy` and `/personal/repos/*/pushPolicyByAuthor`, and refuses a change to them.

### Moving settings between servers

The panel's **Export** and **Import** buttons work on any host that has the settings API: they need no other route. Export downloads a file with `format: "shepherd-settings"`, `version: 1`, the server's `hosts` (host name, label and bots, by key) and the viewer's `personal` settings (`src/settings-transfer.ts`). Import fits the file to the server in the browser, using `GET /api/settings`: host keys follow host names, `me` stays the server's when `/personal/me` is not editable (the file's entry that shares a login with the viewer takes that id; an entry with only the same id is renamed to `<id>-imported`), hosts are added only when `/deployment/hosts` is editable, and fields that are not editable keep their values. The viewer then saves with an ordinary `PUT`, so the host's checks apply as usual.

### The settings schema

`bun run build:client` writes `dist/settings.schema.json`. It is a JSON Schema (draft-07) of a `SettingsDocument`, `{ "personal": …, "deployment": … }`, and it is the same set of rules that this server uses for `config.json` and for `PUT /api/settings`. To check a `PUT`, validate `{ "personal": <the request's personal>, "deployment": <your deployment settings> }` and send each failure as an `invalid` error at its pointer. Then check the rules that the schema cannot have: `fields`, the limits and your own refusals.

The schema uses only these keywords: `$ref` (to `#/definitions/…`), `type` (one or a list), `enum`, `minLength`, `pattern`, `minimum`, `exclusiveMinimum` (a number), `minItems`, `minProperties`, `required`, `properties`, `additionalProperties`, `propertyNames` and `items`. A number must also be finite. It adds these Shepherd keywords:

| Keyword | Rule |
| --- | --- |
| `x-keyOf` | The value (or the property name, under `propertyNames`) is a key of the object at this JSON pointer in the document, for example `/deployment/hosts`. |
| `x-memberOf` | The value is equal to one of the values at this pointer. A `*` segment matches every item, for example `/personal/team/*/id`. |
| `x-uniqueBy` | No two items of the array have the same value of this property. Report the error at that property of the later item. |
| `x-message` | The message of a failed check: a string for every check, or an object of keyword to message (`default` for the others). For a missing `required` property, use the message of that property's own schema. |
| `x-label` | A name for an array item in messages, such as `{owner}/{name}`. |

A message can have these placeholders: `{path}` (the path of the value, without its first segment: `team[0] (alice).pushPolicy`), `{parent}` (the path of its parent), `{item}` (the path of the nearest array item, or the parent), `{key}` (the last segment), `{value}`, `{enum}` (the allowed values, quoted, separated by commas) and `{options}` (the values of `x-keyOf` or `x-memberOf`). After an array item, a path adds its `x-label` in parentheses, when every field of the label is a non-empty string. The messages do not have to match this server's text exactly, but the pointers do.

The schema allows an empty `repos`, for a host that finds PRs by author. This server refuses that itself, because it finds PRs in the listed repos.

### Team and member views

`/api/config` sends `mode`. `"personal"` is the viewer's own dashboard. `"team"` or `"member"` is a dashboard that the host defines for a team or one person, for example from a URL parameter. There, the viewer's personal settings do not apply, so the client hides the settings button and shows whose dashboard it is: `viewLabel` (the name of the team or person) and a link to `personalUrl` (the viewer's own dashboard), when the host sends them.

In a team or member view, the client keeps the viewer's theme, refresh interval, sort order, drafts and dormant switches and Shipped range from the browser's storage. The bells and the person, repo, approval and tile filters start from the defaults there, and the client does not save them, so they do not change the viewer's own dashboard.

## What the host page must include

The client renders all its markup into the mount element. The host page must load these files:

- `styles.css` from the Shepherd server.
- Font Awesome 6.5.2, for the icons: `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css`.
- The Geist and Geist Mono fonts: `https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap`. Without them, the dashboard uses the system fonts.

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
<link rel="stylesheet" href="/path/to/shepherd/styles.css">
```

## Styles

All the rules in `styles.css` start with `.shepherd`, the class that the client adds to the mount element. The CSS variables (`--bg`, `--text` and the others) and the dark theme also apply only to that element. The file does not change `html`, `body`, the elements of the host page, or the variables on `:root`. The animation names start with `shepherd-`.

- The theme button and the saved theme set `data-theme` on the mount element, not on `<html>`. Without a saved theme, the dashboard follows the system setting (`prefers-color-scheme`).
- The column headers of the list stick to the top of the window (with `header: false`) or below the top bar. When the host page has its own fixed header, set `--sticky-top` on the mount element to the height of that header, for example `#shepherd { --sticky-top: 56px; }`. A rule with any selector works, because `styles.css` does not set this variable.

## Limits

- One dashboard on each page. The client keeps its state in the module, so a second mount element stays empty.
- The client keeps the IDs of its elements, for example `#q`, `#groups` and `#popover`, because its code finds them by ID. It looks for them only inside the mount element, so an element with the same ID on the host page does not change the dashboard. But a page with two elements with the same ID is not valid HTML, and the host's CSS rules for these IDs also apply to the dashboard. Do not use these IDs on the host page.
- The host's CSS rules for element names (for example `button` or `input`) also apply in the dashboard, when a rule of the client does not set the same property.
- The host's CSS rules for class names also apply in the dashboard, when a rule of the client does not set the same property. The dashboard uses common class names, for example `.row`, `.popover`, `.badge`, `.tile`, `.empty`, `.search`, `.status` and `.avatar`. For example, a CSS framework rule `.row { margin-left: -15px; }` moves each row of the dashboard. Limit such rules to the host's own elements. The avatar background is an exception: it has `!important`, so a host `.avatar` rule with `!important` does not hide the colors of the initials avatars.
- The layout changes at fixed widths of the window (`@media (max-width: …)`), not of the mount element. In a mount element that is much narrower than the window, the dashboard keeps the wide columns and overflows the element. Give the mount element the full width of the window, less a small margin.
- The popover and the "Copied" tip use `position: fixed`. When an ancestor of the mount element has a `transform` or a `filter`, they show at the wrong position.
- The client renders a `<main>` element. Do not put the mount element in another `<main>`.
- The keyboard shortcuts (`R` to refresh, `/` to go to the filter, `Esc` to close the popover) work on all of the page. `R` and `/` do not work when the focus is in a text field, a `<select>` or an element with `contenteditable`.

## Invalid values

The client ignores a value that is not valid, and uses the default for it:

- When `window.SHEPHERD` is not an object, the client ignores it.
- When `apiBase` is not a path that starts with one `/` and not a URL that starts with `http://` or `https://`, the client uses `/api`. For example, `''`, `api`, `//example.com` and `http:/example.com` are not valid.
- When `apiBase` has a `\`, a space, a tab, a newline, a `?`, a `#`, or a user name or password, the client uses `/api`.
- The client ignores each header that has a value that is not a string, or a name or value that the browser does not accept.
- When `mount` is not a string or an element, or is an empty string, the client uses `#shepherd`.
- When `header` is not `true` or `false`, the client shows the header.
- When `apiTrailingSlash` is not `true` or `false`, the client adds no slash.

## Headers and the token

The client sets the headers of each API call in this order. A later header with the same name replaces an earlier one.

1. The `headers` from `window.SHEPHERD`.
2. The headers of the call itself, for example `content-type` on a `POST`.
3. `Authorization: Bearer <token>`, when the page has a token from a `#token=` link (see [Token](configuration.md#token-optional)). The client adds it only when the headers from steps 1 and 2 have no `Authorization` header.

When `window.SHEPHERD` is an object, the page has no token. The hash and the browser storage of the page belong to the host page. The client does not read a `#token=` from the hash, does not remove it, and does not reload the page when it changes. It also does not read or write the token that the standalone dashboard saves in the browser storage. So a host that signs in with cookies or HTTP Basic authentication keeps working, also on an origin where the standalone dashboard ran before. Give the API its own authentication in `headers`. An API on the same origin also gets the cookies and the HTTP Basic credentials of the browser.

The standalone page sends its token only to the default `/api`. As a second guard, the client never sends the token to an `apiBase` URL on another origin (another scheme, host or port).

When `/api/config` answers 401 and `window.SHEPHERD` is an object, the page shows a general message. Only the local server prints a `#token=` link.

## Without `window.SHEPHERD`

When the page does not set `window.SHEPHERD`, the client renders the dashboard with the brand header into `#shepherd`, and sends its requests to `/api/*` with the same headers as before. The local page (`public/index.html`) has only this element. It also has the `shepherd-page` class on `<html>`, so that the page has the color of the dashboard theme. A host page does not need this class.
