// Server refresh rules: the `refresh` and `rowRefresh*` config keys, and the list cache in "list" mode. Run with `bun test`.

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { MIN_ROW_REFRESH_MS, problems, publicConfig } from './config.ts';
import type { GhRunner } from './gh.ts';
import { createPrService } from './prs.ts';
import type { Config } from './types.ts';

const base: Config = {
	me: 'alice',
	team: [{ id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice' } }],
	hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null } },
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
};

const withHost = (extra: Record<string, unknown>): Config =>
	({ ...base, hosts: { github: { ...base.hosts.github!, ...extra } } }) as Config;

describe('refresh config', () => {
	test('without the new keys, the public config keeps the old rules', () => {
		expect(problems(base)).toEqual([]);
		const pub = publicConfig(base);
		expect(pub.refresh).toBe('rows');
		expect(pub.hosts.github!.rowRefreshFloorMs).toBeUndefined();
		expect(pub.hosts.github!.rowRefreshLowBudgetMs).toBeUndefined();
	});

	test('valid values pass and reach the public config', () => {
		const c: Config = { ...withHost({ rowRefreshFloorMs: 300_000, rowRefreshLowBudgetMs: MIN_ROW_REFRESH_MS }), refresh: 'list' };
		expect(problems(c)).toEqual([]);
		const pub = publicConfig(c);
		expect(pub.refresh).toBe('list');
		expect(pub.hosts.github).toMatchObject({ rowRefreshFloorMs: 300_000, rowRefreshLowBudgetMs: 10_000 });
	});

	test('bad values are reported', () => {
		expect(problems({ ...base, refresh: 'never' as never })).toEqual(['`refresh` must be "rows" or "list", or no such field']);
		for (const v of [-1, 0, 1_000, 9_999, '60000', Number.NaN, Infinity, null]) {
			expect(problems(withHost({ rowRefreshFloorMs: v }))).toEqual([
				'hosts.github.rowRefreshFloorMs must be a number of milliseconds (10000 or more), or no such field',
			]);
			expect(problems(withHost({ rowRefreshLowBudgetMs: v }))).toEqual([
				'hosts.github.rowRefreshLowBudgetMs must be a number of milliseconds (10000 or more), or no such field',
			]);
		}
	});
});

function service(remaining?: number, config: Config = { ...base, refresh: 'list' }) {
	const queries: string[] = [];
	const state = { fail: false };
	const gh: GhRunner = {
		rate: remaining === undefined ? {} : { github: { remaining, limit: 5000, resetAt: '', at: Date.now() } },
		get: () => Promise.reject(new Error('not used')),
		query: async <T>(_host: string, _q: string, vars?: Record<string, unknown>) => {
			queries.push(String(vars?.q));
			await Bun.sleep(5);
			if (state.fail) throw new Error('search failed');
			return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } as T;
		},
	};
	return { prs: createPrService(config, gh), queries, state };
}

describe('listHost', () => {
	afterEach(() => setSystemTime());

	test('a call reuses the list cache', async () => {
		const { prs, queries } = service();
		await prs.listHost('github', []);
		await prs.listHost('github', []);
		expect(queries).toHaveLength(1);
	});

	test('in "list" mode, every call reuses a list that is less than 10 seconds old', async () => {
		const { prs, queries } = service();
		const start = Date.now();
		await prs.listHost('github', []);
		setSystemTime(new Date(start + 9_900)); // older than the 2-second cache of "rows" mode, but under 10 seconds
		await prs.listHost('github', []);
		expect(queries).toHaveLength(1);
		setSystemTime(new Date(start + 10_100));
		await prs.listHost('github', []);
		expect(queries).toHaveLength(2);
	});

	test('in "rows" mode, the list cache stays at 2 seconds', async () => {
		const { prs, queries } = service(undefined, base);
		const start = Date.now();
		await prs.listHost('github', []);
		setSystemTime(new Date(start + 1_900));
		await prs.listHost('github', []);
		expect(queries).toHaveLength(1);
		setSystemTime(new Date(start + 2_100));
		await prs.listHost('github', []);
		expect(queries).toHaveLength(2);
	});

	test('calls at the same time share one search', async () => {
		const { prs, queries } = service();
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => prs.listHost('github', [])));
		expect(queries).toHaveLength(1);
		expect(new Set(results.map((r) => r.prs)).size).toBe(1);
	});

	test('a call still reuses the last list when the budget is low', async () => {
		const { prs, queries } = service(100);
		const start = Date.now();
		await prs.listHost('github', []);
		setSystemTime(new Date(start + 10_100));
		const r = await prs.listHost('github', []);
		expect(queries).toHaveLength(1);
		expect(r.throttled).toBe(true);
	});

	test('in "list" mode, a failed search gives its error for 10 seconds', async () => {
		const { prs, queries, state } = service();
		state.fail = true;
		const start = Date.now();
		await expect(prs.listHost('github', [])).rejects.toThrow('search failed');
		state.fail = false;
		setSystemTime(new Date(start + 9_900));
		await expect(prs.listHost('github', [])).rejects.toThrow('search failed');
		expect(queries).toHaveLength(1);
		setSystemTime(new Date(start + 10_100));
		await prs.listHost('github', []);
		expect(queries).toHaveLength(2);
	});

	test('in "rows" mode, a failed search does not wait', async () => {
		const { prs, queries, state } = service(undefined, base);
		state.fail = true;
		await expect(prs.listHost('github', [])).rejects.toThrow('search failed');
		state.fail = false;
		await prs.listHost('github', []);
		expect(queries).toHaveLength(2);
	});
});

describe('getDetail', () => {
	afterEach(() => setSystemTime());

	const now = new Date().toISOString();
	// The smallest DETAIL_QUERY answer that shapeDetail reads.
	const detailData = {
		repository: {
			defaultBranchRef: { name: 'main', target: { oid: 'base0' } },
			stackedOnThis: { nodes: [] },
			pullRequest: {
				number: 1, title: 'PR', url: 'https://github.com/example-org/app/pull/1', state: 'OPEN', merged: false, mergedAt: null,
				isDraft: false, updatedAt: now, createdAt: now, headRefName: 'feature', baseRefName: 'main', headRefOid: 'head0',
				baseRefOid: 'base0', baseRef: { target: { oid: 'base0' } }, body: null, mergeable: 'MERGEABLE', reviewDecision: null,
				additions: 1, deletions: 0, changedFiles: 1, author: { login: 'alice' }, statusCheckRollup: null,
				reviewRequests: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, participants: { totalCount: 0, nodes: [] },
				comments: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [] }, reviewThreads: { nodes: [] },
			},
		},
	};

	function detailService(config: Config) {
		const state = { queries: 0 };
		const gh: GhRunner = {
			rate: {},
			get: () => Promise.reject(new Error('no compare in this test')),
			query: async <T>() => {
				state.queries++;
				return detailData as T;
			},
		};
		return { prs: createPrService(config, gh), state };
	}

	const req = { host: 'github', owner: 'example-org', repo: 'app', number: 1, head: 'feature', base: 'main', force: true };

	test('in "list" mode, a forced call reuses details that are less than 10 seconds old', async () => {
		const { prs, state } = detailService({ ...base, refresh: 'list' });
		const start = Date.now();
		await prs.getDetail(req);
		setSystemTime(new Date(start + 9_900));
		await prs.getDetail(req);
		expect(state.queries).toBe(1);
		setSystemTime(new Date(start + 10_100));
		await prs.getDetail(req);
		expect(state.queries).toBe(2);
	});

	test('in "rows" mode, a forced call reuses details for 1 second only', async () => {
		const { prs, state } = detailService(base);
		const start = Date.now();
		await prs.getDetail(req);
		setSystemTime(new Date(start + 1_100));
		await prs.getDetail(req);
		expect(state.queries).toBe(2);
	});
});
