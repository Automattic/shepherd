# Configuration

`config.json` is local and gitignored; `config.example.json` is the template. To use another file, set `SHEPHERD_CONFIG` to its path relative to the project folder. The server checks the config at startup and lists every problem it finds.

| Key | Purpose |
| --- | --- |
| `port` | Port to listen on. `PORT` in the environment wins. Defaults to `5050`. |
| `me` | The `id` of the team member the dashboard treats as "you". |
| `team[]` | `id`, `name`, `short` (the label on screen), and `logins`: one login per host key, for example `{ "github": "octocat", "work": "ocat" }`. Optional `pushPolicy`: how this person wants to receive changes on their PRs (`review-only`, `stacked-pr` or `push`; see [Push policies](push-policy.md)). |
| `hosts.<key>` | `hostname`, `label`, `concurrency` (the cap on parallel `gh` processes, default 4), `bot` (the AI-review bot's login, or `null`; see [AI-review bots](#ai-review-bots)), optional `proxychains` (a proxychains config path; see [GitHub Enterprise and proxies](github-enterprise.md)), optional `reviewTeams` (see [Review teams](review-teams.md)), and optional `rowRefreshFloorMs` and `rowRefreshLowBudgetMs` (see [Refresh rules](#refresh-rules)). |
| `repos[]` | `host` (a key from `hosts`), `owner`, `name`, and `short` (the label on screen). Optional `maxBaseAgeHours`: flag PRs whose base is older than this many hours. Optional `allAuthors`: `true` lists every open PR in the repo, including PRs by people outside `team` (see [PRs from outside the team](#prs-from-outside-the-team)). Optional `pushPolicy` and `pushPolicyByAuthor` (keyed by team `id` or login): how authors in this repo want to receive changes (see [Push policies](push-policy.md)). |
| `linear` | Optional. `workspace` (the slug in Linear URLs) and `keys` (team prefixes to find in titles and branch names). Use `null` to turn ticket links off. |
| `aiReviewLabel` | Optional. The name shown for the AI-review column and tile. Defaults to `AI review`. |
| `herdr` | Optional. See [herdr terminal panes](herdr.md). `enabled` (default `true`; used only when herdr is installed and running) and `transcriptTailKb` (how much of each agent transcript to search, default 192). |
| `refresh` | Optional. `"rows"` (the default) or `"list"`. Sets when the page loads a row again. See [Refresh rules](#refresh-rules). |
| `features` | Optional. Turns dashboard features off: `shipped`, `followups` and `herdr`, each `true` or `false`. A missing key means on. See [Turn features off](#turn-features-off). |
| `ignoreParticipants` | Logins to leave out of Participants. Use it for bots and service accounts that appear as ordinary users. Logins ending in `[bot]` or `-bot` are always left out. |

The server binds to `127.0.0.1` only. The MCP endpoint refuses browser requests from other origins.

## PRs from outside the team

By default Shepherd lists open PRs written by people in `team`, plus PRs that request a review from someone whose bell is on or from one of the host's [`reviewTeams`](review-teams.md). A PR by a contributor outside the team that requests nobody, and that no bell catches, never appears.

Set `allAuthors: true` on a repo to list every open PR in it, whoever wrote it:

```json
{ "host": "github", "owner": "example-org", "name": "plugin", "short": "plugin", "allAuthors": true }
```

Use it on repos where the team reviews most outside work. On a busy repo it fills the dashboard with PRs the team doesn't own, and each listed PR costs a details fetch. Those PRs still only wait on someone through the usual rules in [What "waiting on" means](dashboard.md#what-waiting-on-means); being listed doesn't put them in anyone's queue. Shipped and `merged_prs` stay limited to the team's PRs.

## Refresh rules

The server sends these values to the page, so the person who runs the server controls how often each page asks for rows. Without them, the page uses the rules in [How refreshing works](refreshing.md).

- `hosts.<key>.rowRefreshFloorMs`: the shortest time, in milliseconds, before the page loads a row on this host again. The default is 120000 (2 minutes) on github.com and on hosts that report a GraphQL budget, and 20000 (20 seconds) on other hosts. The page still waits at least the refresh interval that the user selects. The value must be 10000 (10 seconds) or more.
- `hosts.<key>.rowRefreshLowBudgetMs`: the time, in milliseconds, between row loads on this host when fewer than 500 GraphQL points remain. The default is 600000 (10 minutes). The value must be 10000 (10 seconds) or more, and not less than `rowRefreshFloorMs` when both are set: a low budget must not make rows load sooner.
- `refresh: "list"`: the page loads a row only when the list shows a new **updated** time for it, when the row has no details yet, when the user clicks the refresh button of the row, or when the PR leaves the list. If that load fails, or the row is hidden at that time, the page tries again on a later tick. The page does not load a row from the list more often than every 10 seconds. **Refresh now** asks for a new list and does not ask for each row. The server reuses a list that is less than 10 seconds old for all list calls, and after a failed search it returns the same error for 10 seconds. A row load, also a forced one, reuses details that are less than 10 seconds old. The floors above then have no effect. GitHub does not change a PR's **updated** time when its checks finish or when its base branch moves. So in this mode, the status and base age of a row can stay old until the PR changes in another way, or until the user clicks the refresh button of the row.

```json
{
  "refresh": "list",
  "hosts": {
    "github": { "hostname": "github.com", "label": "GitHub", "bot": null, "rowRefreshFloorMs": 300000 }
  }
}
```

Use `"list"` on a server that many people use. All pages share the server's `gh` logins, so the cost of a page load or a refresh must not grow with the number of rows. With `"list"`, a change that does not move a PR's **updated** time, for example a new check result, shows only after the user clicks the refresh button of the row.

## Turn features off

Set a feature to `false` to remove it from the dashboard:

```json
"features": { "shipped": false, "followups": false, "herdr": false }
```

| Key | What `false` removes |
| --- | --- |
| `shipped` | The [Shipped](dashboard.md#shipped) section and its controls. Follow-ups show only in Shipped, so this also turns `followups` off. |
| `followups` | The [follow-up](dashboard.md#follow-ups) pills, the **Needs follow-up** chip and the follow-up count in the Shipped summary. Shipped stays. |
| `herdr` | The [herdr](herdr.md) chips on PR rows. `"herdr": { "enabled": false }` also turns this off. |

When a feature is off, the page sends no request for it and shows no error for it. The server answers 404 on the endpoint of that feature (`/api/merged`, `/api/followups`, or `/api/herdr/*`). The page keeps your saved choices for a feature that is off, such as the range or the **Needs follow-up** chip, and uses them again when the feature is on. The MCP tools do not change.

`GET /api/config` sends the result as `features`, with all three keys. A different server that has only the open-PR endpoints can send the same object with `false` values. When a server sends no `features` object, or leaves a key out, the page treats that feature as on.

## Token (optional)

On a machine with more than one user, anyone on it can reach `127.0.0.1`. To lock `/mcp` and `/api/*`, start the server with a token:

```sh
export SHEPHERD_TOKEN=$(openssl rand -hex 32)   # to keep it across restarts, store it in a file only you can read (chmod 600)
bun run start
```

Every request to `/mcp` and `/api/*` then needs `Authorization: Bearer <token>`, or it gets a 401. The token is read from the environment, not `config.json`, because config files are often readable by other users. The server prints the dashboard link as `http://127.0.0.1:5050/#token=…`. Open it once: the page keeps the token in this browser's storage for that address and sends it as a header. The part after `#` never reaches the server. Without `SHEPHERD_TOKEN`, nothing changes. While Shepherd is stopped, another user could listen on the same port and receive the token from an open tab or agent. The browser also keeps the token for that address after the tab closes, so a server that takes the port later can read it the next time you open the dashboard. Stop open tabs and agents with Shepherd, and change the token after a while.

## AI-review bots

Set `bot` on a host to the login of a bot that leaves inline review comments. Shepherd counts the review threads that bot opened and that are still unresolved. It reads severity and kind when the comment opens with a bold title followed by `·`-separated tags:

```text
**Throttle check is not atomic** · fix here · medium
```

Severities are `critical`, `high`, `medium`, `low` and `info`. A tag of `nit`, or a tail that starts with `below`, marks a finding as minor. Comments in any other shape still count, as `info`.
