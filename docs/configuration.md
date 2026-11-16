# Configuration

`config.json` is local and gitignored; `config.example.json` is the template. To use another file, set `SHEPHERD_CONFIG` to its path relative to the project folder. The server checks the config at startup and lists every problem it finds.

| Key | Purpose |
| --- | --- |
| `port` | Port to listen on. `PORT` in the environment wins. Defaults to `5050`. |
| `me` | The `id` of the team member the dashboard treats as "you". |
| `team[]` | `id`, `name`, `short` (the label on screen), and `logins`: one login per host key, for example `{ "github": "octocat", "work": "ocat" }`. |
| `hosts.<key>` | `hostname`, `label`, `concurrency` (the cap on parallel `gh` processes, default 4), `bot` (the AI-review bot's login, or `null`; see [AI-review bots](#ai-review-bots)), optional `proxychains` (a proxychains config path; see [GitHub Enterprise and proxies](github-enterprise.md)), and optional `reviewTeams` (see [Review teams](review-teams.md)). |
| `repos[]` | `host` (a key from `hosts`), `owner`, `name`, and `short` (the label on screen). Optional `maxBaseAgeHours`: flag PRs whose base is older than this many hours. Optional `allAuthors`: `true` lists every open PR in the repo, including PRs by people outside `team` (see [PRs from outside the team](#prs-from-outside-the-team)). |
| `linear` | Optional. `workspace` (the slug in Linear URLs) and `keys` (team prefixes to find in titles and branch names). Use `null` to turn ticket links off. |
| `aiReviewLabel` | Optional. The name shown for the AI-review column and tile. Defaults to `AI review`. |
| `herdr` | Optional. See [herdr terminal panes](herdr.md). `enabled` (default `true`; used only when herdr is installed and running) and `transcriptTailKb` (how much of each agent transcript to search, default 192). |
| `ignoreParticipants` | Logins to leave out of Participants. Use it for bots and service accounts that appear as ordinary users. Logins ending in `[bot]` or `-bot` are always left out. |

The server binds to `127.0.0.1` only. The MCP endpoint refuses browser requests from other origins.

## PRs from outside the team

By default Shepherd lists open PRs written by people in `team`, plus PRs that request a review from someone whose bell is on or from one of the host's [`reviewTeams`](review-teams.md). A PR by a contributor outside the team that requests nobody, and that no bell catches, never appears.

Set `allAuthors: true` on a repo to list every open PR in it, whoever wrote it:

```json
{ "host": "github", "owner": "example-org", "name": "plugin", "short": "plugin", "allAuthors": true }
```

Use it on repos where the team reviews most outside work. On a busy repo it fills the dashboard with PRs the team doesn't own, and each listed PR costs a details fetch. Those PRs still only wait on someone through the usual rules in [What "waiting on" means](dashboard.md#what-waiting-on-means); being listed doesn't put them in anyone's queue. Shipped and `merged_prs` stay limited to the team's PRs.

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
