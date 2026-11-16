// How a PR's author wants to receive changes from reviewers and their agents, shared by the dashboard and the MCP tools.

import type { PushPolicy, RepoConfig, TeamMember } from './types.ts';

/** From the strictest to the most open. */
export const PUSH_POLICIES: readonly PushPolicy[] = ['review-only', 'stacked-pr', 'push'];

export const isPushPolicy = (v: unknown): v is PushPolicy => typeof v === 'string' && (PUSH_POLICIES as readonly string[]).includes(v);

/**
 * Where a resolved policy came from:
 * - `own`: the PR is yours (`me`), so pushing is always fine.
 * - `fork`: the head branch is in a fork, so the policy is review-only.
 * - `repo-author`: the repo's `pushPolicyByAuthor` entry for the author.
 * - `author`: the author's `pushPolicy`.
 * - `repo`: the repo's `pushPolicy`.
 * - `author-and-repo`: both were set; the stricter one applies.
 * - `repo-outside-team`: the repo allows pushes, but the author is outside the team, so it counts as stacked-pr.
 */
export type PushPolicySource = 'own' | 'fork' | 'repo-author' | 'author' | 'repo' | 'author-and-repo' | 'repo-outside-team';

type ConfiguredSource = Exclude<PushPolicySource, 'own' | 'fork'>;

export interface ResolvedPushPolicy {
	/** null when nothing in the config covers this PR. */
	policy: PushPolicy | null;
	source: PushPolicySource | null;
	/** What a reviewer, or an agent working for one, should do. */
	instruction: string;
}

export const PUSH_POLICY_LABELS: Record<PushPolicy, string> = {
	'review-only': 'Review only',
	'stacked-pr': 'Stacked PRs',
	push: 'Pushes OK',
};

/** What each policy asks of a reviewer or agent. */
export const PUSH_POLICY_INSTRUCTIONS: Record<PushPolicy | 'unset', string> = {
	'review-only': "Leave review comments and suggested changes only. Don't push commits to this branch or open PRs against it.",
	'stacked-pr': "Don't push to this branch. Put changes in a separate PR whose base is this PR's branch, and link it in a comment.",
	push: 'Pushing commits to this branch is welcome. Say what you changed in a comment.',
	unset: 'No preference is set. Comments and suggestions are fine; ask the author before pushing to this branch.',
};

/** Why the policy applies, put before the policy's instruction so an agent knows whose wish it is. */
const SOURCE_NOTES: Record<ConfiguredSource, string> = {
	'repo-author': "Set for this author in this repo's Shepherd config.",
	author: "The author's preference.",
	repo: "This repo's default; the author has no preference set.",
	'author-and-repo': "The stricter of the author's preference and this repo's default.",
	'repo-outside-team': 'This repo allows pushes from the team, but the author is outside the team.',
};

export const OWN_PR_INSTRUCTION = 'This is your own PR. Push commits to it as needed.';

const forkNote = (fork: string) => `The head branch is in ${fork}'s fork, so changes can't go to it from here.`;

/** The order the rules apply in, for agents (the `team` tool). docs/push-policy.md lists the same order. */
export const PUSH_POLICY_RULE =
	"First match wins: (1) your own PRs always allow pushes; (2) a PR from a fork is review-only, because its branch is not in the repo; (3) the repo's pushPolicyByAuthor entry for the author; (4) a repo pushPolicy of push counts as stacked-pr for authors outside the team; (5) when the author and the repo both have a pushPolicy, the stricter one; (6) whichever of the two is set; (7) no policy, so ask the author before pushing. Each PR from list_prs, review_queue and get_pr carries the policy that applies to it.";

interface PolicyConfig {
	/** The team id of the person running Shepherd. Their PRs always allow pushes. */
	me?: string;
	team: TeamMember[];
	repos: RepoConfig[];
}

interface PolicyTarget {
	host: string;
	owner: string;
	repo: string;
	/** The PR author's login on `host`. */
	author: string;
	/** The fork owner's login when the head branch is in another repo; null or absent for a branch in the same repo. */
	fork?: string | null;
}

const stricter = (a: PushPolicy, b: PushPolicy): PushPolicy => (PUSH_POLICIES.indexOf(a) <= PUSH_POLICIES.indexOf(b) ? a : b);

/**
 * The `pushPolicyByAuthor` entry for one author. A key that is a team id names only that member, so an outside author
 * whose login equals a team id never picks up that member's entry. Any other key is a login. When a member has both an
 * id key and a login key, the id key wins.
 */
function byAuthorEntry(team: TeamMember[], byAuthor: Record<string, PushPolicy>, login: string, author: TeamMember | undefined): PushPolicy | undefined {
	const teamIds = new Set(team.map((m) => m.id.toLowerCase()));
	const entries = Object.entries(byAuthor).map(([k, v]) => [k.toLowerCase(), v] as const);
	const id = author?.id.toLowerCase();
	const hit = (id !== undefined ? entries.find(([k]) => k === id) : undefined) ?? entries.find(([k]) => k === login && !teamIds.has(k));
	return hit && isPushPolicy(hit[1]) ? hit[1] : undefined;
}

/** Rules 3 to 6: what the config says for this author in this repo. */
function resolveConfigured(team: TeamMember[], repo: RepoConfig | undefined, login: string, author: TeamMember | undefined): [PushPolicy, ConfiguredSource] | null {
	const entry = repo?.pushPolicyByAuthor ? byAuthorEntry(team, repo.pushPolicyByAuthor, login, author) : undefined;
	if (entry) return [entry, 'repo-author'];

	const fromAuthor = author?.pushPolicy;
	const fromRepo = repo?.pushPolicy;
	if (!author && fromRepo === 'push') return ['stacked-pr', 'repo-outside-team'];
	if (fromAuthor && fromRepo) return [stricter(fromAuthor, fromRepo), 'author-and-repo'];
	if (fromAuthor) return [fromAuthor, 'author'];
	if (fromRepo) return [fromRepo, 'repo'];
	return null;
}

/** The policy that applies to one PR, in the order of PUSH_POLICY_RULE. */
export function resolvePushPolicy(config: PolicyConfig, pr: PolicyTarget): ResolvedPushPolicy {
	const login = pr.author.toLowerCase();
	const author = config.team.find((m) => m.logins[pr.host]?.toLowerCase() === login);
	if (author && config.me !== undefined && author.id === config.me) return { policy: 'push', source: 'own', instruction: OWN_PR_INSTRUCTION };

	if (pr.fork) return { policy: 'review-only', source: 'fork', instruction: `${forkNote(pr.fork)} ${PUSH_POLICY_INSTRUCTIONS['review-only']}` };

	const repo = config.repos.find((r) => r.host === pr.host && r.owner.toLowerCase() === pr.owner.toLowerCase() && r.name.toLowerCase() === pr.repo.toLowerCase());
	const found = resolveConfigured(config.team, repo, login, author);
	if (!found) return { policy: null, source: null, instruction: PUSH_POLICY_INSTRUCTIONS.unset };
	const [policy, source] = found;
	return { policy, source, instruction: `${SOURCE_NOTES[source]} ${PUSH_POLICY_INSTRUCTIONS[policy]}` };
}
