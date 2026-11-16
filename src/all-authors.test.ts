// Repos with `allAuthors`: every open PR is listed, not only the team's. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import type { GhRunner } from './gh.ts';
import { createPrService } from './prs.ts';
import type { Config, RepoConfig, TeamMember } from './types.ts';

const alice: TeamMember = { id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice' } };

const node = (repo: string, number: number, author: string) => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/example-org/${repo}/pull/${number}`,
	isDraft: false,
	updatedAt: '2026-01-02T00:00:00Z',
	createdAt: '2026-01-01T00:00:00Z',
	headRefName: `b${number}`,
	baseRefName: 'main',
	author: { login: author },
	repository: { name: repo, owner: { login: 'example-org' } },
});

function service(repos: RepoConfig[]) {
	const queries: string[] = [];
	const gh: GhRunner = {
		rate: {},
		get: () => Promise.reject(new Error('not used')),
		query: async <T>(_host: string, _q: string, vars?: Record<string, unknown>) => {
			const q = String(vars?.q);
			queries.push(q);
			// The open repo has a PR by the team and one by an outsider; the team-only repo has one by the team.
			const nodes = q.includes('author:')
				? [node('app', 1, 'alice')]
				: q.includes('repo:example-org/open')
					? [node('open', 2, 'alice'), node('open', 3, 'outsider')]
					: [];
			return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
		},
	};
	const config: Config = {
		me: 'alice',
		team: [alice],
		hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null } },
		repos,
	};
	return { prs: createPrService(config, gh), queries };
}

describe('listHost with allAuthors repos', () => {
	const app: RepoConfig = { host: 'github', owner: 'example-org', name: 'app', short: 'app' };
	const open: RepoConfig = { host: 'github', owner: 'example-org', name: 'open', short: 'open', allAuthors: true };

	test('without allAuthors, only the team search runs', async () => {
		const { prs, queries } = service([app]);
		const { prs: list } = await prs.listHost('github', []);
		expect(queries).toEqual(['is:pr is:open repo:example-org/app author:alice']);
		expect(list.every((p) => !p.inAllAuthorsRepo)).toBe(true);
	});

	test('an allAuthors repo is searched without the author filter, and kept out of the team search', async () => {
		const { prs, queries } = service([app, open]);
		const { prs: list } = await prs.listHost('github', []);
		expect(queries.sort()).toEqual(['is:pr is:open repo:example-org/app author:alice', 'is:pr is:open repo:example-org/open']);
		const byNumber = new Map(list.map((p) => [p.number, p]));
		expect([...byNumber.keys()].sort()).toEqual([1, 2, 3]);
		expect(byNumber.get(1)).toMatchObject({ authoredByTeam: true, inAllAuthorsRepo: false });
		expect(byNumber.get(2)).toMatchObject({ authoredByTeam: true, inAllAuthorsRepo: true });
		expect(byNumber.get(3)).toMatchObject({ authoredByTeam: false, inAllAuthorsRepo: true });
	});

	test('when every repo on the host is allAuthors, no team search runs', async () => {
		const { prs, queries } = service([open]);
		await prs.listHost('github', []);
		expect(queries).toEqual(['is:pr is:open repo:example-org/open']);
	});
});
