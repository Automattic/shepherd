# Push policies

Reviewers, and the agents working for them, sometimes push fixes straight to someone else's PR branch. Some authors welcome that. Others only want comments, or want changes as a separate PR they can merge into their branch. A push policy records that preference, so people and agents can check it before they touch a branch.

| Policy | What a reviewer or agent should do |
| --- | --- |
| `review-only` | Leave review comments and suggested changes only. Don't push to the branch or open PRs against it. |
| `stacked-pr` | Don't push to the branch. Put changes in a separate PR whose base is the author's branch, and link it in a comment. |
| `push` | Push commits to the branch. Say what changed in a comment. |

With no policy set, comments and suggestions are fine, and you should ask the author before pushing.

## Setting it

Set policies in `config.json`, or in the dashboard's settings panel (the gear button), where each person and each repo has a push policy field.

Set a person's policy on their team entry. It covers every PR they write:

```json
{ "id": "alex", "name": "Alex Example", "short": "Alex", "logins": { "github": "alex" }, "pushPolicy": "review-only" }
```

Set a repo's policy on the repo. It covers every PR in that repo, including PRs by people outside `team`. For people outside `team`, a repo policy of `push` counts as `stacked-pr`:

```json
{ "host": "github", "owner": "example-org", "name": "app", "short": "app", "pushPolicy": "stacked-pr" }
```

Set a policy for one author in one repo with `pushPolicyByAuthor`. Use it for exceptions, or for contributors outside the team. A key is a team `id` or a login on that repo's host:

- A key that is a team `id` names only that team member. An outside author whose login is the same doesn't get that entry.
- Any other key is a login. It works for team members and for people outside the team.
- When a team member has both an `id` key and a login key, the `id` key wins.

Shepherd prints a warning at startup for a key that matches no team `id` or login, which is either a typo or an outside author. It also warns about two keys that name the same person, and about a key that is one member's `id` and another member's login.

```json
{
  "host": "github", "owner": "example-org", "name": "app", "short": "app",
  "pushPolicy": "review-only",
  "pushPolicyByAuthor": { "alex": "push", "outside-contributor": "stacked-pr" }
}
```

## Which one applies

The first rule that matches applies:

1. Your own PRs (the `me` team member's) always allow pushes, whatever the config says.
2. A PR from a fork is `review-only`. Its branch isn't in the repo, so changes can't go to it, and a PR can't use it as a base.
3. An entry for the author in the repo's `pushPolicyByAuthor`.
4. A repo `pushPolicy` of `push` counts as `stacked-pr` for an author outside the team.
5. When both the author and the repo have a `pushPolicy`, the stricter one. `review-only` is the strictest and `push` the most open.
6. Whichever of the two is set.
7. No policy. Ask the author before pushing.

The `team` MCP tool gives agents the same rule as `pushPolicyRule`.

## Where it shows

- **Dashboard:** a pill in the PR's details line (**Review only**, **Stacked PRs** or **Pushes OK**). Hover it for the instruction. It shows whether the policy comes from the author, the repo or a fork. It isn't shown on your own PRs or when no policy applies.
- **MCP:** every PR from `list_prs`, `review_queue` and `get_pr` has `pushPolicy`, with `policy`, `source` and `instruction`. `source` is one of these, or null when no policy applies:
  - `own`: your own PR
  - `fork`: the PR comes from a fork
  - `repo-author`: the repo's `pushPolicyByAuthor` entry
  - `author`: the author's `pushPolicy`
  - `repo`: the repo's `pushPolicy`
  - `author-and-repo`: both were set, and the stricter one applies
  - `repo-outside-team`: a repo `push` that counts as `stacked-pr` for an outside author

  The `instruction` starts with where the policy came from, so an agent can tell an author's own wish from a repo default. A fork PR's `branch` shows as `owner:branch`. The `team` tool lists each person's and each repo's policy, what each policy asks for (`pushPolicies`) and the order of the rules (`pushPolicyRule`). Agents should follow `instruction` before they push to a PR's branch or open a PR against it.

Shepherd only reports the preference. It doesn't block pushes on GitHub.
