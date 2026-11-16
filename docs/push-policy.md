# Push policies

Reviewers, and the agents working for them, sometimes push fixes straight to someone else's PR branch. Some authors welcome that. Others only want comments, or want changes as a separate PR they can merge into their branch. A push policy records that preference, so people and agents can check it before they touch a branch.

| Policy | What a reviewer or agent should do |
| --- | --- |
| `review-only` | Leave review comments and suggested changes only. Don't push to the branch or open PRs against it. |
| `stacked-pr` | Don't push to the branch. Put changes in a separate PR whose base is the author's branch, and link it in a comment. |
| `push` | Push commits to the branch. Say what changed in a comment. |

With no policy set, comments and suggestions are fine, and you should ask the author before pushing.

## Setting it

Set a person's policy on their team entry. It covers every PR they write:

```json
{ "id": "alex", "name": "Alex Example", "short": "Alex", "logins": { "github": "alex" }, "pushPolicy": "review-only" }
```

Set a repo's policy on the repo. It covers every PR in that repo, including PRs by people outside `team`:

```json
{ "host": "github", "owner": "example-org", "name": "app", "short": "app", "pushPolicy": "stacked-pr" }
```

Set a policy for one author in one repo with `pushPolicyByAuthor`, keyed by team `id` or by the author's login on that repo's host. Use it for exceptions, or for contributors outside the team:

```json
{
  "host": "github", "owner": "example-org", "name": "app", "short": "app",
  "pushPolicy": "review-only",
  "pushPolicyByAuthor": { "alex": "push", "outside-contributor": "stacked-pr" }
}
```

## Which one applies

1. An entry for the author in the repo's `pushPolicyByAuthor`.
2. Otherwise, when both the author and the repo have a `pushPolicy`, the stricter one. `review-only` is the strictest and `push` the most open.
3. Otherwise, whichever of the two is set.
4. Otherwise, no policy.

A policy is about other people's changes. It doesn't stop the author from pushing to their own branch.

## Where it shows

- **Dashboard:** a pill next to the author (**Review only**, **Stacked PRs** or **Pushes OK**). Hover it for the instruction. It isn't shown on your own PRs or when no policy applies.
- **MCP:** every PR from `list_prs`, `review_queue` and `get_pr` has `pushPolicy`, with `policy`, `source` (`repo-author`, `author`, `repo`, `author-and-repo`, or null) and `instruction`. The `team` tool lists each person's and each repo's policy. Agents should follow `instruction` before they push to or open a PR against someone else's branch.

Shepherd only reports the preference. It doesn't block pushes on GitHub.
