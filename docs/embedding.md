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

- `queries.json` is `{ "apiVersion": <API_VERSION>, "fields": { "detailPr", "miniPr", "lightPr", "mergedPr" } }`. Each field is a GraphQL field set: the selection of `pullRequest(number:$n)` in the detail query, of the `parent` and `stackedOnThis` nodes, of a PR in the open list search, and of a PR in the merged search. Each one is a bare selection body, with no outer braces, no variables and no aliases. The host wraps it, for example in `fragment DetailFields on PullRequest { <detailPr> }` or `... on PullRequest { <lightPr> }`, and supplies its own variables, aliases and arguments around it. A host should check `apiVersion` and stop when it is not the version that the host was written for.
- `contract/<case>.json` is `{ name, context, input, expected }`. `input` has the `data` of a detail query response for an invented PR, and the `host`, `owner`, `repo`, `number`, `head` and `base` of the request. `expected` is the `PrDetail` that this server's `getDetail()` shapes from it. A host can test its own shaping against these files: shape `input.data` with `context`, and compare the result with `expected`.

The `context` is the same in every file: the hosts `ghe` (hostname `github.example.com`, AI-review bot `review-bot`) and `github` (hostname `github.com`, no bot), and Linear workspace `example` with no keys, without review teams or ignored participants. `fetchedAt` is the fixed time `2000-01-01T00:00:00.000Z`. `baseAge` needs a compare call that the fixtures do not have, so for an open PR it is the "unknown" object with `error: "compare not available in contract"`, and for a merged or closed PR it is null. The contract covers the detail shape only, not the list or the merged shapes. See [Contributing](../CONTRIBUTING.md#queriesjson-and-contract) for how the files are made.

## Settings

A host can give each viewer their own settings: the team, repos, review teams, Linear and features. The client edits them in its settings panel, through two calls. The host keeps the settings in its own storage. `src/types.ts` has the shapes.

- `GET /api/settings` sends a `SettingsResponse`: `personal` and `deployment` (the values), `version`, `mode`, `fields` and, optionally, `problems`.
- `PUT /api/settings` gets a `SettingsPutRequest`: `{ "version": "…", "personal": { … } }`. It sends the new `SettingsResponse` when it saves. Otherwise it sends a `SettingsErrorResponse`: `{ "error", "errors": [ { "path", "code", "message" } ] }`.

| Status | When |
| --- | --- |
| 400 | The body is not a settings request. |
| 409 | `version` is not the current version, because another tab or another program saved first. Add the current settings as `settings`. The panel offers to load them. |
| 422 | One or more fields are refused. Each entry of `errors` names its field with a JSON pointer into the request (`/personal/repos/2`), so the panel shows the message at that field. |

The `code` of each error:

- `invalid`: the value breaks the settings schema.
- `not_editable`: the field is not editable for this viewer, or the change is to another person's push policy.
- `limit`: the value is over a cost limit, for example too many repos.
- `refused`: the host refuses a value with the right shape. For example, the viewer may not watch that repo. Use it for any check that the schema cannot make.

`fields` maps JSON pointers to `{ "editable": boolean, "reason"?: string }`. A `*` segment matches any item, and the longest matching pointer wins. A pointer with no match is editable under `/personal` and not editable under `/deployment`. Send `{ "editable": false }` for the whole of `/deployment` when the viewer cannot change it, and for each feature that the host does not have (for example `/personal/features/herdr`). The panel shows these fields read-only, with the `reason`. The host must also refuse a change to them in `PUT`, because a request can send it anyway.

Push policies follow one more rule, whatever `fields` says: a viewer can change only their own. In `personal.team`, only the `pushPolicy` of the member whose `id` is `personal.me` can change. In a repo's `pushPolicyByAuthor`, only the entry whose key is that member's id or their login on the repo's host can change. A new member with a `pushPolicy` is a change too.

### The settings schema

`bun run build:client` writes `dist/settings.schema.json`. It is a JSON Schema (draft-07) of a `SettingsDocument`, `{ "personal": …, "deployment": … }`, and it is the same set of rules that this server uses for `config.json` and for `PUT /api/settings`. To check a `PUT`, validate `{ "personal": <the request's personal>, "deployment": <your deployment settings> }` and send each failure as an `invalid` error at its pointer. Then check the rules that the schema cannot have: `fields`, the push policy owners, the limits and your own refusals.

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
