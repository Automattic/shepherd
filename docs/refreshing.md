# How refreshing works

Every row loads and refreshes on its own. Five rows load in parallel; the sixth browser connection stays free for the list check. On the server, each host has its own cap on running `gh` processes, and two requests for the same PR at the same time share one call.

On each tick, the page:

1. Fetches the list of open PRs: the team's PRs, every open PR in repos with `allAuthors`, plus one search for each person whose bell is on.
2. Reloads any row whose **updated** time changed.
3. Reloads any row older than the interval, with a floor of 20 seconds on hosts without a rate limit and 2 minutes on github.com.

The list carries the details the server already has for each PR's current **updated** time. The page shows them at once and asks for a row again only when they are older than the limit in step 3, so reloading the page does not fetch every row again. **Refresh now** still asks for every row.

Loading a PR's details also makes one REST compare call to measure the base age. The result is cached per head commit for 10 minutes, so new commits on the base branch don't trigger a call on every refresh. A failed call is retried after a minute.

The github.com floor exists because it allows 5,000 GraphQL points an hour, and a 5-second interval would use them up. The header shows the remaining github.com budget. Below 500, rows reload at most every 10 minutes; below 300, the server reuses the last list.

Refreshing pauses while the tab is in the background and catches up when you return. **Refresh now** ignores the floors.

When a PR leaves the list, the page checks it directly before changing anything, because GitHub search can lag:

- **Merged:** the row shows a **Merged** badge for six seconds, then fades out.
- **Closed:** the row fades out.
- **Still open but no longer matching** (for example, you submitted the review it asked for): the row is removed after two checks in a row.

## Server settings

The server can change these rules (see [Refresh rules](configuration.md#refresh-rules)):

- `rowRefreshFloorMs` on a host replaces the floor in step 3 for that host.
- `rowRefreshLowBudgetMs` on a host replaces the 10 minutes for that host when its budget is low.
- `refresh: "list"` removes step 3. A row with details loads again only when its **updated** time changes, when the user clicks its refresh button, or when it leaves the list. If that load fails, or the row is hidden at that time, the page tries again on a later tick. The page does not load a row from the list more often than every 10 seconds, so a row that changes again within 10 seconds loads on a later tick. **Refresh now** and `R` ask for one new list and do not ask for each row. The server reuses a list until it is 10 seconds old, for all list calls (also the MCP tools), so a click can show a list that is up to 10 seconds old. After a failed search, the server returns the same error for 10 seconds. List calls at the same time share one search, and a low budget still reuses the last list. A server in `"rows"` mode keeps the 2-second list cache.

With `refresh: "list"`, a page load, an auto refresh and **Refresh now** each make one `/api/prs` call when the server already has the details. A row that the server has no details for still makes one `/api/pr` call.
