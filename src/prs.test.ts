import { expect, test } from 'bun:test';
import type { GhRunner } from './gh.ts';
import { createPrService } from './prs.ts';
import type { Config } from './types.ts';

const config: Config = {
	me: 'alice',
	team: [
		{ id: 'alice', name: 'Alice Example', short: 'Alice', logins: { github: 'alice' } },
		{ id: 'bob', name: 'Bob Example', short: 'Bob', logins: { github: 'bob' } },
	],
	hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: 'review-helper' } },
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
};

interface Review {
	state: string;
	submittedAt: string | null;
	author: { __typename: string; login: string } | null;
}
// The fake PR merges at 12:00.
const by = (login: string, state = 'APPROVED', __typename = 'User', submittedAt = '2026-11-10T11:00:00Z'): Review => ({ state, submittedAt, author: { __typename, login } });

function fakeGh(issueCount = 1, reviews: Review[] = [by('bob')], mergedBy: { login: string } | null = { login: 'bob' }) {
	const queries: string[] = [];
	const gh: GhRunner = {
		rate: {},
		async query<T>(_host: string, _query: string, vars: Record<string, unknown> = {}) {
			queries.push(String(vars.q));
			await Bun.sleep(5);
			const node = {
				number: 7,
				title: 'Ship it',
				url: 'https://github.com/example-org/app/pull/7',
				mergedAt: '2026-11-10T12:00:00Z',
				author: { login: 'alice' },
				mergedBy,
				latestOpinionatedReviews: { nodes: reviews },
				repository: { name: 'app', owner: { login: 'example-org' } },
			};
			return { search: { issueCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node] } } as T;
		},
		get: () => Promise.reject(new Error('not used')),
	};
	return { gh, queries };
}

test('listMerged runs one search per host for the team, and shares it', async () => {
	const { gh, queries } = fakeGh();
	const prs = createPrService(config, gh);
	const [a, b] = await Promise.all([prs.listMerged('github'), prs.listMerged('github')]);
	await prs.listMerged('github'); // cached
	expect(queries).toHaveLength(1);
	expect(queries[0]).toMatch(/^is:pr is:merged merged:>=\d{4}-\d{2}-\d{2} repo:example-org\/app author:alice author:bob sort:updated-desc$/);
	expect(a).toBe(b);
	expect(a.prs.map((p) => [p.key, p.author, p.mergedAt])).toEqual([['github:example-org/app#7', 'alice', '2026-11-10T12:00:00Z']]);
	expect(a.total).toBe(1);
	expect([a.prs[0]!.mergedBy, a.prs[0]!.approvedByHuman]).toEqual(['bob', true]);
});

test('a merged PR is approved by a human only when someone other than the author and the bots approved it', async () => {
	const approved = async (reviews: Review[]) => (await createPrService(config, fakeGh(1, reviews).gh).listMerged('github')).prs[0]!.approvedByHuman;
	expect(await approved([])).toBe(false);
	expect(await approved([by('carol')])).toBe(true); // someone outside the team counts
	expect(await approved([by('bob', 'CHANGES_REQUESTED'), by('carol', 'COMMENTED'), by('dan', 'DISMISSED')])).toBe(false);
	expect(await approved([by('bob', 'CHANGES_REQUESTED'), by('carol')])).toBe(true);
	// The author, also in another case, is not a second pair of eyes.
	expect(await approved([by('Alice')])).toBe(false);
	// Bots: the configured AI-review bot, a login that looks like a bot, an app that only its type marks, and a deleted account.
	expect(await approved([by('Review-Helper'), by('dependabot[bot]'), by('some-app', 'APPROVED', 'Bot'), { state: 'APPROVED', submittedAt: '2026-11-10T11:00:00Z', author: null }])).toBe(false);
	expect(await approved([by('review-helper'), by('bob')])).toBe(true);
	// An approval that arrives after the merge says nothing about what merged.
	expect(await approved([by('bob', 'APPROVED', 'User', '2026-11-10T12:30:00Z')])).toBe(false);
	// A login that `ignoreParticipants` or the `-bot` suffix marks as a bot does not count either.
	expect(await approved([by('deploy-bot')])).toBe(false);
});

test('a merged PR with no known merger has none', async () => {
	const { prs } = await createPrService(config, fakeGh(1, [], null).gh).listMerged('github');
	expect([prs[0]!.mergedBy, prs[0]!.approvedByHuman]).toEqual([null, false]);
});

test('listMerged reports when GitHub matched more than it returned', async () => {
	const { gh } = fakeGh(800);
	const { total, prs } = await createPrService(config, gh).listMerged('github');
	expect(total).toBeGreaterThan(prs.length);
});
