# Using the dashboard

## The table

| Column | What it shows |
| --- | --- |
| **Pull request** | State icon, title and number, repo, author, Linear tickets, and related PRs. A stacked PR sits under its parent in smaller, inset text. |
| **Waiting on** | Reviewers asked directly, plus an orange **You** pill whenever the PR is waiting on you for any reason (hover it for why). A red **Author** pill means changes were requested and the author hasn't pushed since. Teammates whose bell is on get an orange ring. Team requests (for example from CODEOWNERS) are grey chips. When the team is one of your `reviewTeams`, the **You** pill gets a team icon. |
| **Approvals** | Who approved (green check) and who asked for changes (red cross), with names. |
| **AI review** | Unresolved review threads opened by the host's AI-review `bot`. **fix** means severity medium or higher and not a nit; **minor** covers everything else. Click the count to list every finding with its file and a link. Shows "n/a" on hosts with no bot. The column name comes from `aiReviewLabel`. |
| **Participants** | Everyone who commented, reviewed or committed, except the author and bots, most recently active first. Hover an avatar to see when that person was last active. Below them, a small line shows who acted last (author included) and how: comment, review or push. It turns orange as **your turn** when someone else had the last word on a PR you wrote or took part in, unless your approval still stands. |
| **Status** | Draft, checks, merge conflicts, a thumbs-up when the review decision is approved, how old the base is (see below), and lines added and removed. |
| **Updated** | When the PR last changed. Hover the row for a refresh button that reloads just that row. |

If [herdr](herdr.md) is running, rows also show a chip for each terminal pane working on the PR. For how often rows reload, see [How refreshing works](refreshing.md).

## Order and approved work

Rows are sorted in four bands:

1. **Ready to ship** (green border): approved, with no merge conflicts and no failed checks. Pending checks don't block.
2. **Approved but blocked** (dark cyan border): approved, but a PR has merge conflicts or failed checks.
3. **Waiting on you** (orange left bar).
4. Everything else, most recently updated first.

## How old the base is

Some hosts reject a push when the PR's base is older than a set number of hours. Shepherd shows a **base 26h old** pill so you see it before the push fails.

- The age is the committer date of the merge base between the PR branch and its base branch, from GitHub's compare API.
- For a stacked PR, the age is measured against the repo's default branch, since that is what the bottom of the stack has to catch up with.
- Set `maxBaseAgeHours` on a repo to get a limit. It only applies to PRs measured against the default branch; a PR into another branch, such as a release branch, shows its age without the limit. The pill appears at half the limit and turns orange past it. If the age can't be checked, the pill reads **base ?** instead of looking fresh.
- Without a limit, the pill only appears once the base is a week old, and never warns.

The MCP tools return `baseAgeHours` for every open PR, and `baseTooOld` when the repo has a limit.

## Shipped

The **Shipped** section, collapsed under the tiles, lists the PRs the team merged in the tracked repos: **This week** (since Monday 00:00 in your time zone), **Last week** (the Monday to Sunday before) or **Last 30 days**. A line on top counts them per person; the list below is newest first. The server searches the last 32 days once a minute, one search per host, and the page filters to the range you pick, so switching ranges sends no request. The page remembers the range and whether the section is open.

### Follow-ups

Reviewers often approve with a list of asks that don't block the merge. Once the PR merges, nobody sees them again. A Shipped row shows a **3 follow-ups** pill when people left such asks on the PR; click it to list them, with who wrote each one, where (description, review, comment, or file and line) and a link.

The **Needs follow-up** chip next to the range shows only the merged PRs with at least one follow-up, and the section summary says how many there are (for example **51 this week · 30 need follow-up**). The count ends in **+** while follow-ups are still loading. It appears once the section has been opened, since follow-ups load only then. The page remembers whether the chip is on.

What counts as a follow-up:

- Every list item under a heading, or a short line ending in a colon, that says the list doesn't block, such as **Notes that do not block:**, **Non-blocking:**, **Optional:**, **Nits:**, **Follow-ups:**, **Before merging:** or **Fix these before the next PR:**. The list ends at the next paragraph. Ticked checkboxes and empty items such as "None" are left out.
- Any other line that asks for later work: "in a follow-up", "a follow-up issue", "follow-up for Domains", "(follow-up)", needs a decision, doesn't block, an upper-case TODO, or a line that starts with "Optional:", "Non-blocking:", "Nit:" or "Follow-up:". "follow-up" as a noun or adjective for something else ("the follow-up review marks it resolved", "This follow-up changes…") doesn't count.
- In a review or comment, a line that puts work in a separate, next or later PR. In the description, the same words describe the author's own stack ("the next PR adds the loader line"), so they don't count there.

A line that ends in a colon introduces what follows, so it never counts on its own. "Out of scope" never counts: it explains why something isn't part of the work.

Shepherd reads the description, the last 50 reviews, the last 100 comments and the first 10 comments of the first 100 inline threads. It skips the host's AI-review `bot` (its findings have their own column), other bots, comments addressed to the bot, resolved inline threads, quoted text, tables and code blocks. Without any matching text, the row has no pill.

A wrong flag costs more than a missed one, so an ask the code may have handled since doesn't count: one from a review of an older commit, a comment written before the last commit, or an outdated inline thread. Nothing in GitHub's data says which ask a commit handled, so some real asks drop out too. The popover lists them dimmed under **May be done**, after the ones that count. A PR with only such asks has no pill. The description always counts, since it describes the final code.

Follow-ups load only while Shipped is open, for the PRs in the range shown. The server asks GitHub for up to 10 PRs of a repo in one GraphQL query and keeps the result for 10 minutes, so a week with 50 merged PRs in one repo costs about 5 queries, then none for 10 minutes.

## What "waiting on" means

A PR is waiting on someone when any of these is true:

- **Requested:** GitHub lists them as a pending reviewer, asked directly rather than through a team. Submitting any review clears it; the author can re-request it.
- **Team:** the PR requests a review from one of the host's `reviewTeams` (see [Review teams](review-teams.md)). It counts for every team member except the author. It doesn't count on drafts, for someone also asked directly, or for someone whose approval still stands.
- **Their turn:** someone else commented, reviewed or pushed most recently on a PR they wrote or took part in.
- **Author:** they wrote it, someone requested changes, and nothing has been pushed since.

The **Waiting on you** tile, the orange left bar, the sort order and each person's hourglass all use this definition, as does the `review_queue` MCP tool. The rules live in `src/waiting.ts`.

A PR counts as approved when GitHub's review decision is approved, or when at least one person approved and nobody requested changes. A stack counts as approved only when every open PR in it is approved, and it is green only when none of them has conflicts or failed checks. A partly approved stack stays in the normal order; its Approvals column shows which parts are done.

## Related pull requests

- **Stacks.** A PR whose base branch is another tracked PR's head branch in the same repo shares that PR's row, at any depth. Every PR after the first sits one level in, in stack order. If the parent is not tracked (for example, someone outside the team wrote it), the row shows an **on #N** chip that links to it.
- **Chips.** Dashed chips link to PRs that share a Linear ticket, PRs linked in the description, and untracked PRs stacked on this one. A row shows at most five, then **+N**.
- **Linear tickets.** When `linear` is configured: taken from `linear.app` links in the description, and from the configured team keys (such as `ENG-1234`) in the title or branch name.

## Controls

- **Refresh interval.** 5s, 30s, 1m (default), 5m or 15m. The thin bar under the header shows the time until the next check.
- **Refresh now.** The button in the header, or press `R`. It reloads every row.
- **Theme.** Light or dark. It follows your system until you choose.
- **Summary tiles.** Click one to filter: Waiting on you, Approved, Changes requested, AI review open. **Open PRs** clears the filter.
- **People.** Each person has three buttons:
  - **Name** (with their PR count): show only PRs they wrote.
  - **Hourglass** (with a count): show only PRs waiting on their review.
  - **Bell:** add PRs from anyone that request that person's review, and ring them in orange in **Waiting on**. Yours is on by default.

  Selecting several names shows PRs by any of them, and the same goes for hourglasses. Names and hourglasses combine, so Miguel's name plus your hourglass shows Miguel's PRs waiting on you. An hourglass only sees PRs already on the dashboard, so turn on that person's bell to include PRs from outside the team.
- **Repo and approval chips.** These narrow the list. With none selected in a cluster, nothing is filtered; select any combination to show only those.
  - **Repos:** one chip per tracked repo.
  - **Approved** (approved PRs and fully approved stacks) and **Partially approved** (stacks where only some PRs are approved). They act on whole stacks, never splitting one, and each chip counts its groups. Select both to see all approved work.
- **Drafts and Dormant 60d+.** Show or hide those PRs. Drafts are shown by default. Dormant PRs (no update for 60 days) are hidden by default, unless they wait on you.
- **Search.** Matches title, branch, repo, number, author and ticket. Press `/` to focus it.

Your choices are saved in the browser.
