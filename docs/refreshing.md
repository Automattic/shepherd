# How refreshing works

Every row loads and refreshes on its own. Five rows load in parallel; the sixth browser connection stays free for the list check. On the server, each host has its own cap on running `gh` processes, and two requests for the same PR at the same time share one call.

On each tick, the page:

1. Fetches the list of open PRs: the team's PRs, plus one search for each person whose bell is on.
2. Reloads any row whose **updated** time changed.
3. Reloads any row older than the interval, with a floor of 20 seconds on hosts without a rate limit and 2 minutes on github.com.

Loading a PR's details also makes one REST compare call to measure the base age. The result is cached per head commit for 10 minutes, so new commits on the base branch don't trigger a call on every refresh. A failed call is retried after a minute.

The github.com floor exists because it allows 5,000 GraphQL points an hour, and a 5-second interval would use them up. The header shows the remaining github.com budget. Below 500, rows reload at most every 10 minutes; below 300, the server reuses the last list.

Refreshing pauses while the tab is in the background and catches up when you return. **Refresh now** ignores the floors.

When a PR leaves the list, the page checks it directly before changing anything, because GitHub search can lag:

- **Merged:** the row shows a **Merged** badge for six seconds, then fades out.
- **Closed:** the row fades out.
- **Still open but no longer matching** (for example, you submitted the review it asked for): the row is removed after two checks in a row.
