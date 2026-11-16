// How a PR's author wants to receive changes from reviewers and their agents, shared by the dashboard and the MCP tools.

import type { PushPolicy, RepoConfig, TeamMember } from './types.ts';

/** From the strictest to the most open. */
export const PUSH_POLICIES: readonly PushPolicy[] = ['review-only', 'stacked-pr', 'push'];

export const isPushPolicy = (v: unknown): v is PushPolicy => typeof v === 'string' && (PUSH_POLICIES as readonly string[]).includes(v);

/** Where a resolved policy came from. */
export type PushPolicySource = 'repo-author' | 'author' | 'repo' | 'author-and-repo';

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

export const PUSH_POLICY_INSTRUCTIONS: Record<PushPolicy | 'unset', string> = {
	'review-only': "Leave review comments and suggested changes only. Don't push commits to this branch or open PRs against it.",
	'stacked-pr': "Don't push to this branch. Put changes in a separate PR whose base is this PR's branch, and link it in a comment.",
	push: 'Pushing commits to this branch is welcome. Say what you changed in a comment.',
	unset: 'No preference is set. Comments and suggestions are fine; ask the author before pushing to this branch.',
};

interface PolicyConfig {
	team: TeamMember[];
	repos: RepoConfig[];
}

interface PolicyTarget {
	host: string;
	owner: string;
	repo: string;
	/** The PR author's login on `host`. */
	author: string;
}

const stricter = (a: PushPolicy, b: PushPolicy): PushPolicy => (PUSH_POLICIES.indexOf(a) <= PUSH_POLICIES.indexOf(b) ? a : b);

/**
 * The author's preference for one PR. A repo's `pushPolicyByAuthor` entry for the author wins. Otherwise the
 * author's `pushPolicy` and the repo's `pushPolicy` both apply, and the stricter one is used.
 */
export function resolvePushPolicy(config: PolicyConfig, pr: PolicyTarget): ResolvedPushPolicy {
	const login = pr.author.toLowerCase();
	const author = config.team.find((m) => m.logins[pr.host]?.toLowerCase() === login);
	const repo = config.repos.find((r) => r.host === pr.host && r.owner.toLowerCase() === pr.owner.toLowerCase() && r.name.toLowerCase() === pr.repo.toLowerCase());

	const done = (policy: PushPolicy | null, source: PushPolicySource | null): ResolvedPushPolicy => ({
		policy,
		source,
		instruction: PUSH_POLICY_INSTRUCTIONS[policy ?? 'unset'],
	});

	// Keys are team ids or logins on the repo's host.
	const byAuthor = repo?.pushPolicyByAuthor;
	if (byAuthor) {
		const hit = Object.entries(byAuthor).find(([k]) => {
			const key = k.toLowerCase();
			return key === login || (author !== undefined && key === author.id.toLowerCase());
		});
		if (hit && isPushPolicy(hit[1])) return done(hit[1], 'repo-author');
	}

	const fromAuthor = author?.pushPolicy;
	const fromRepo = repo?.pushPolicy;
	if (fromAuthor && fromRepo) return done(stricter(fromAuthor, fromRepo), 'author-and-repo');
	if (fromAuthor) return done(fromAuthor, 'author');
	if (fromRepo) return done(fromRepo, 'repo');
	return done(null, null);
}
