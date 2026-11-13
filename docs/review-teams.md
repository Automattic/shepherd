# Review teams

Some teams mark a PR as ready for review by requesting a review from a GitHub team instead of naming people. To put those PRs in everyone's queue, list the teams on the host:

```json
"hosts": {
  "github": { "hostname": "github.com", "label": "GitHub", "bot": null, "reviewTeams": ["my-org/reviewers"] }
}
```

Each entry is `org/team`, as in GitHub's `team-review-requested:` search. Shepherd treats every person in `team` with a login on that host as a member. An open PR in the tracked repos that requests one of these teams then waits on all of them except its author, with a **You** pill that has a team icon. It leaves a person's queue once they approve, and drafts never count. When GitHub clears the team request, for example after a member reviews on the team's behalf, the PR leaves everyone's queue. Without `reviewTeams`, team requests show as grey chips and don't count. Teams are set per host because team names belong to one GitHub host. Shepherd doesn't read team membership from GitHub, so if a host lists several teams, everyone counts as a member of all of them.

These PRs stay visible even after 60 idle days, like a direct request, on the dashboard and in the MCP tools.

Agents can ask for these PRs directly. Every PR the MCP tools return with details has `reviewTeamRequested` (true on an open, non-draft PR that requests a review team) and `waitingOnReviewFrom.reviewTeams` (which ones, as `org/team`). `list_prs` with `review_team_requested: true` returns those PRs, including ones by people outside `team`; a PR whose details could not be loaded is listed under `errors` instead. The `team` tool lists the review teams per host.
