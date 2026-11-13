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
	hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null } },
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
};

function fakeGh(issueCount = 1) {
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
});

test('listMerged reports when GitHub matched more than it returned', async () => {
	const { gh } = fakeGh(800);
	const { total, prs } = await createPrService(config, gh).listMerged('github');
	expect(total).toBeGreaterThan(prs.length);
});
