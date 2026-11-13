# herdr terminal panes

If [herdr](https://herdr.dev) is installed and running on the same machine (macOS or Linux), PR rows show a chip for each herdr pane working on that PR. Click a chip to focus that pane in herdr. Without herdr, nothing changes. Set `"herdr": { "enabled": false }` in `config.json` to turn it off.

A pane is linked to a PR by any of these, strongest first:

| Signal | Chip icon | Meaning |
| --- | --- | --- |
| Tag | tag | The pane has a `pr` token naming the PR: `herdr pane report-metadata <pane> --source shepherd --token pr=<url or repo#number>`. |
| Transcript | speech bubbles | The pane runs an agent (Claude Code or Codex) whose recent transcript mentions the PR's URL, `owner/repo#number`, `repo#number`, or its branch. Only focused sessions count: one that mentions more than four tracked PRs is surveying, not working, unless one PR has 40% or more of its mentions. |
| Branch | branch | The pane's checkout is the PR's repo, on the PR's head branch, and no other tracked PR uses that branch. |

The chip also shows:
- **Status dot:** the agent's state from herdr. It pulses while working, is orange when blocked, green when done, grey when idle, and hollow for a plain shell.
- **Git counts:** a pencil with the number of uncommitted changes, and an up arrow with the number of unpushed commits.

Panes are ordered by signal strength, then agent state, then work in progress, then most recent change. Hover a chip for the pane title, branch and why it was linked.

Shepherd reads only the last 192 KB of each agent transcript (`herdr.transcriptTailKb` changes this), searches it for PR identifiers, and keeps nothing.
