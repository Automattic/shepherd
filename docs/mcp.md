# MCP server for agents

The same process answers MCP at `http://127.0.0.1:5050/mcp`. It uses the Streamable HTTP transport, is stateless and read-only, and shares the dashboard's `gh` access and caches. It exists only while the server runs.

| Tool | Use it for | Arguments |
| --- | --- | --- |
| `review_queue` | "What is waiting on me?" or on someone else, with the reason for each PR (`requested`, `team`, `turn` or `author`) | `person` (default `me`) |
| `list_prs` | The team's open PRs (in the tracked repos, or in any repo on hosts in [any-repo mode](configuration.md#prs-in-any-repo)), plus every open PR in repos with `allAuthors`, filtered | `author`, `repo`, `waiting_on`, `include_drafts`, `include_dormant`, `has_ai_review_findings`, `review_team_requested`, `limit` |
| `merged_prs` | "What did we ship this week?": the team's merged PRs with a count per person, in the server's time zone. Each PR has `followUps`, the number of non-blocking asks left on it that the code hasn't changed since (see [Follow-ups](dashboard.md#follow-ups)), or null when they could not be fetched | `range` (`this-week`, `last-week` or `last-30-days`; default `this-week`), `author`, `repo`, `include_follow_ups` (list them as `followUpItems`) |
| `get_pr` | One PR in full: every unresolved AI-review finding, participants with last-active times, who acted last (and whether that was you or the author), stack, checks, follow-ups (who, where, the line and a link; `followUpsMaybeDone` counts the ones the code may have handled since, which are left out), and any herdr panes working on it | `url`, or `repo` and `number` |
| `team` | The roster with each person's logins and push policy, the tracked repos with their push policies, the hosts in any-repo mode (`anyRepo`, with their orgs), what each push policy asks for and the rule that decides which one applies, the AI-review bots, the Linear workspace and the review teams | |

`merged_prs` fetches follow-ups for every PR in the range that isn't cached yet, 10 PRs of a repo per query, and keeps them for 10 minutes. A first `last-30-days` call on a busy team can take several seconds; later calls are served from the cache.

Every PR that `list_prs`, `review_queue` and `get_pr` return has `pushPolicy`: how changes to its branch should arrive, where that came from (`source`), and an `instruction` to follow before pushing to the branch. Your own PRs always allow pushes, and PRs from forks are review-only. See [Push policies](push-policy.md).

Agents can name people by `id`, first name or any of their logins, and repos by short name or owner/name. On a host in any-repo mode, `owner/name` also names a repo that is not tracked; `get_pr` then needs the PR URL when that repo is in scope on more than one host. Data is at most 60 seconds old. An unknown person or repo returns an error that lists the valid names.

Example prompts once it is connected:

- "Using Shepherd, what is waiting on my review, and who else has looked at each one?"
- "Which of Alex's PRs have unresolved AI-review findings marked fix?"
- "Get https://github.com/owner/repo/pull/123 from Shepherd and tell me who to ping."
- "Which PRs we merged last week left follow-ups behind, and what are they?"
- "Can I push my fix to https://github.com/owner/repo/pull/123, or should I open a PR against it?"

If the server runs with `SHEPHERD_TOKEN`, register it with the header:

```sh
claude mcp add --transport http --scope user shepherd http://127.0.0.1:5050/mcp \
  --header "Authorization: Bearer $SHEPHERD_TOKEN"
```

To check the endpoint without a client (add `-H "Authorization: Bearer $SHEPHERD_TOKEN"` when a token is set):

```sh
curl -s http://127.0.0.1:5050/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '[.result.tools[].name]'
```
