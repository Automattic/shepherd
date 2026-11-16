// Server refresh rules: the `refresh` and `rowRefresh*` config keys, and forced list calls. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import { problems, publicConfig } from './config.ts';
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
		const c: Config = { ...withHost({ rowRefreshFloorMs: 300_000, rowRefreshLowBudgetMs: 0 }), refresh: 'list' };
		expect(problems(c)).toEqual([]);
		const pub = publicConfig(c);
		expect(pub.refresh).toBe('list');
		expect(pub.hosts.github).toMatchObject({ rowRefreshFloorMs: 300_000, rowRefreshLowBudgetMs: 0 });
	});

	test('bad values are reported', () => {
		expect(problems({ ...base, refresh: 'never' as never })).toEqual(['`refresh` must be "rows" or "list", or no such field']);
		for (const v of [-1, '60000', Number.NaN, Infinity, null]) {
			expect(problems(withHost({ rowRefreshFloorMs: v }))).toEqual([
				'hosts.github.rowRefreshFloorMs must be a number of milliseconds (0 or more), or no such field',
			]);
			expect(problems(withHost({ rowRefreshLowBudgetMs: v }))).toEqual([
				'hosts.github.rowRefreshLowBudgetMs must be a number of milliseconds (0 or more), or no such field',
			]);
		}
	});
});

function service(remaining?: number, config: Config = { ...base, refresh: 'list' }) {
	const queries: string[] = [];
	const gh: GhRunner = {
		rate: remaining === undefined ? {} : { github: { remaining, limit: 5000, resetAt: '', at: Date.now() } },
		get: () => Promise.reject(new Error('not used')),
		query: async <T>(_host: string, _q: string, vars?: Record<string, unknown>) => {
			queries.push(String(vars?.q));
			await Bun.sleep(5);
			return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } as T;
		},
	};
	return { prs: createPrService(config, gh), queries };
}

describe('listHost with force', () => {
	test('a normal call reuses the short list cache', async () => {
		const { prs, queries } = service();
		await prs.listHost('github', []);
		await prs.listHost('github', []);
		expect(queries).toHaveLength(1);
	});

	test('a forced call skips the cache once the cached list is a second old', async () => {
		const { prs, queries } = service();
		await prs.listHost('github', []);
		await prs.listHost('github', [], { force: true }); // under a second: still cached
		expect(queries).toHaveLength(1);
		await Bun.sleep(1_050);
		await prs.listHost('github', [], { force: true });
		expect(queries).toHaveLength(2);
	});

	test('a forced call uses the cache when the server is not in "list" mode', async () => {
		const { prs, queries } = service(undefined, base);
		await prs.listHost('github', []);
		await Bun.sleep(1_050);
		await prs.listHost('github', [], { force: true });
		expect(queries).toHaveLength(1);
	});

	test('forced calls at the same time share one search', async () => {
		const { prs, queries } = service();
		const results = await Promise.all([1, 2, 3, 4, 5].map(() => prs.listHost('github', [], { force: true })));
		expect(queries).toHaveLength(1);
		expect(new Set(results.map((r) => r.prs)).size).toBe(1);
	});

	test('a forced call still reuses the last list when the budget is low', async () => {
		const { prs, queries } = service(100);
		await prs.listHost('github', []);
		await Bun.sleep(1_050);
		const r = await prs.listHost('github', [], { force: true });
		expect(queries).toHaveLength(1);
		expect(r.throttled).toBe(true);
	});
});
