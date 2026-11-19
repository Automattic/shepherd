// Detail batches: the background prefetch that /api/prs starts, getDetails for the MCP fan-outs, and getDetail as a batch of one.
// A fake `gh` answers the search and the batch queries by reading the `pr<i>` aliases and the variables, and records every call.
// Every test is top-level, so `bun test -t '^<name>$'` runs it alone. Run with `bun test`.

import { afterEach, expect, setSystemTime, spyOn, test } from 'bun:test';
import type { GhRunner } from './gh.ts';
import { createMcpHandler } from './mcp.ts';
import { createPrService, NotFoundError, type DetailRequest, type PrService } from './prs.ts';
import { buildDetailBatch } from './queries.ts';
import type { Config, LightPr, RateLimit } from './types.ts';

afterEach(() => setSystemTime());

// ---------------------------------------------------------------------------
// The world: PRs by host and repo, and the fake `gh` that answers from it

interface Spec {
	number: number;
	head?: string;
	base?: string;
	updatedAt?: string;
	/** The PR that this PR is stacked on (`up0`), and the PRs stacked on this one (`dn0`). */
	up?: { number: number; title: string };
	down?: { number: number; title: string }[];
}
type World = Record<string, Record<string, Spec[]>>;

interface Call {
	kind: 'search' | 'batch' | 'refs' | 'followups';
	host: string;
	query: string;
	vars: Record<string, unknown>;
	owner?: string;
	name?: string;
	/** For a batch: the PR numbers in alias order. */
	numbers?: number[];
}

const HOSTNAMES: Record<string, string> = { github: 'github.com', ghe: 'github.example.com' };
const iso = () => new Date().toISOString();
const advance = (ms: number) => setSystemTime(new Date(Date.now() + ms));
const spec = (number: number, extra: Partial<Spec> = {}): Spec => ({ number, ...extra });
const specs = (from: number, count: number): Spec[] => Array.from({ length: count }, (_, i) => spec(from + i));

function configFor(world: World, refresh: 'rows' | 'list' = 'rows'): Config {
	return {
		me: 'alice',
		team: [{ id: 'alice', name: 'Alice', short: 'Alice', logins: Object.fromEntries(Object.keys(world).map((h) => [h, 'alice'])) }],
		hosts: Object.fromEntries(Object.keys(world).map((h) => [h, { hostname: HOSTNAMES[h]!, label: h, bot: null }])),
		repos: Object.entries(world).flatMap(([host, repos]) =>
			Object.keys(repos).map((id) => ({ host, owner: id.split('/')[0]!, name: id.split('/')[1]!, short: id.split('/')[1]!, allAuthors: true }))
		),
		refresh,
	};
}

interface Fake {
	gh: GhRunner;
	calls: Call[];
	compares: string[];
	/** Batches answered so far (a delayed batch is recorded in `calls` when it is sent, and counted here when it is answered). */
	state: { delayMs: number; answered: number; failBatch: (c: Call) => boolean; missing: Set<number>; onAnswer: () => void };
	rate: Record<string, RateLimit>;
	batches: () => Call[];
	searches: () => Call[];
}

function fakeGh(world: World, now = iso()): Fake {
	const calls: Call[] = [];
	const compares: string[] = [];
	const state = { delayMs: 0, answered: 0, failBatch: (_c: Call) => false, missing: new Set<number>(), onAnswer: () => {} };
	const rate: Record<string, RateLimit> = {};
	const find = (host: string, owner: string, name: string, number: number) => world[host]?.[`${owner}/${name}`]?.find((s) => s.number === number);

	const rawPr = (host: string, owner: string, name: string, s: Spec) => ({
		number: s.number, title: `PR ${s.number}`, url: `https://${HOSTNAMES[host]}/${owner}/${name}/pull/${s.number}`, state: 'OPEN', merged: false, mergedAt: null,
		isDraft: false, updatedAt: s.updatedAt ?? now, createdAt: now, headRefName: s.head ?? `feature-${s.number}`, baseRefName: s.base ?? 'main',
		isCrossRepository: false, headRepositoryOwner: null, headRefOid: `head-${s.number}`, baseRefOid: 'base-oid', baseRef: { target: { oid: 'base-oid' } },
		body: null, mergeable: 'MERGEABLE', reviewDecision: null, additions: 1, deletions: 0, changedFiles: 1, author: { login: 'alice' },
		statusCheckRollup: null, reviewRequests: { nodes: [] }, assignees: { nodes: [] }, timelineItems: { nodes: [] }, latestOpinionatedReviews: { nodes: [] }, participants: { totalCount: 0, nodes: [] },
		comments: { nodes: [] }, reviews: { nodes: [] }, commits: { nodes: [] }, reviewThreads: { nodes: [] },
	});
	const mini = (host: string, owner: string, name: string, p: { number: number; title: string }) => ({
		number: p.number, title: p.title, url: `https://${HOSTNAMES[host]}/${owner}/${name}/pull/${p.number}`, author: { login: 'alice' },
	});

	const gh: GhRunner = {
		rate,
		async query<T>(host: string, query: string, vars: Record<string, unknown> = {}) {
			if (vars.q !== undefined) {
				calls.push({ kind: 'search', host, query, vars });
				const repos = [...String(vars.q).matchAll(/repo:(\S+)/g)].map((m) => m[1]!);
				const nodes = repos.flatMap((id) =>
					(world[host]?.[id] ?? []).map((s) => ({
						number: s.number, title: `PR ${s.number}`, url: `https://${HOSTNAMES[host]}/${id}/pull/${s.number}`, isDraft: false,
						updatedAt: s.updatedAt ?? now, createdAt: now, headRefName: s.head ?? `feature-${s.number}`, baseRefName: s.base ?? 'main',
						isCrossRepository: false, headRepositoryOwner: null, author: { login: 'alice', name: 'Alice' },
						repository: { name: id.split('/')[1]!, owner: { login: id.split('/')[0]! } },
					}))
				);
				return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
			}
			const owner = String(vars.owner);
			const name = String(vars.name);
			const indexes = [...query.matchAll(/\bpr(\d+): pullRequest\(/g)].map((m) => Number(m[1]));
			if (indexes.length) {
				const numbers = indexes.map((i) => vars[`n${i}`] as number);
				const call: Call = { kind: 'batch', host, query, vars, owner, name, numbers };
				calls.push(call);
				if (state.delayMs) await Bun.sleep(state.delayMs);
				state.answered++;
				state.onAnswer();
				if (state.failBatch(call)) throw new Error('batch failed: HTTP 502');
				const repository: Record<string, unknown> = { defaultBranchRef: { name: 'main', target: { oid: 'base-oid' } } };
				indexes.forEach((i, k) => {
					const s = find(host, owner, name, numbers[k]!);
					repository[`pr${i}`] = s && !state.missing.has(s.number) ? rawPr(host, owner, name, s) : null;
					if (query.includes(`dn${i}:`)) repository[`dn${i}`] = { nodes: (s?.down ?? []).map((p) => mini(host, owner, name, p)) };
					if (query.includes(`up${i}:`)) repository[`up${i}`] = { nodes: s?.up ? [mini(host, owner, name, s.up)] : [] };
				});
				return { repository } as T;
			}
			if (vars.n !== undefined) {
				calls.push({ kind: 'refs', host, query, vars, owner, name });
				const s = find(host, owner, name, Number(vars.n));
				return { repository: { pullRequest: s ? { headRefName: s.head ?? `feature-${s.number}`, baseRefName: s.base ?? 'main' } : null } } as T;
			}
			calls.push({ kind: 'followups', host, query, vars, owner, name });
			throw new Error('the fake answers no follow-ups');
		},
		async get<T>(_host: string, path: string) {
			compares.push(path);
			return { behind_by: 4, merge_base_commit: { commit: { committer: { date: '2026-11-01T00:00:00Z' } } } } as T;
		},
	};
	return { gh, calls, compares, state, rate, batches: () => calls.filter((c) => c.kind === 'batch'), searches: () => calls.filter((c) => c.kind === 'search') };
}

function setup(world: World, refresh: 'rows' | 'list' = 'rows') {
	const fake = fakeGh(world);
	return { ...fake, svc: createPrService(configFor(world, refresh), fake.gh) };
}

/** What `listPrs` in src/server.ts does, which a test cannot import: send the details the server has, start the prefetch and do not wait for it. */
async function listLikeServer(svc: PrService): Promise<{ rows: LightPr[]; prefetch: Promise<void> }> {
	const settled = await Promise.allSettled(svc.hostKeys.map((h) => svc.listHost(h, [])));
	const rows: LightPr[] = [];
	const throttled: Record<string, boolean> = {};
	settled.forEach((s, i) => {
		if (s.status !== 'fulfilled') return;
		for (const pr of s.value.prs) {
			const detail = svc.cachedDetail(pr.key, pr.updatedAt);
			rows.push(detail ? { ...pr, detail } : pr);
		}
		throttled[svc.hostKeys[i]!] = s.value.throttled;
	});
	return { rows, prefetch: svc.prefetchDetails(rows, throttled) };
}

const sizes = (calls: Call[]) => calls.map((c) => c.numbers!.length).sort((a, b) => b - a);
const reqOf = (host: string, owner: string, repo: string, number: number, extra: Partial<DetailRequest> = {}): DetailRequest => ({ host, owner, repo, number, head: `feature-${number}`, base: 'main', ...extra });

// ---------------------------------------------------------------------------
// The list's prefetch

test('a cold list fetches missing details in batches of ten per repository', async () => {
	const world: World = { github: { 'example-org/a': specs(1, 23), 'example-org/b': specs(101, 4) } };
	const { svc, searches, batches } = setup(world);
	const first = await listLikeServer(svc);
	expect(first.rows).toHaveLength(27);
	expect(first.rows.some((r) => r.detail)).toBe(false);
	await first.prefetch;
	expect(searches()).toHaveLength(1);
	expect(batches()).toHaveLength(4);
	// At most ten PRs per query, and a query holds the PRs of one repo.
	expect(sizes(batches().filter((c) => c.name === 'a'))).toEqual([10, 10, 3]);
	expect(sizes(batches().filter((c) => c.name === 'b'))).toEqual([4]);
	for (const c of batches()) expect(c.numbers!.every((n) => (c.name === 'a' ? n <= 23 : n > 100))).toBe(true);

	advance(3_000); // past the 2-second list cache
	const second = await listLikeServer(svc);
	expect(second.rows).toHaveLength(27);
	for (const r of second.rows) {
		expect(r.detail?.key).toBe(r.key);
		expect(r.detail?.number).toBe(r.number);
		expect(r.detail?.title).toBe(`PR ${r.number}`);
	}
});

test('a warm list sends no detail query', async () => {
	const world: World = { github: { 'example-org/a': specs(1, 23), 'example-org/b': specs(101, 4) } };
	const { svc, searches, batches } = setup(world);
	await (await listLikeServer(svc)).prefetch;
	expect(batches()).toHaveLength(4);

	advance(3_000);
	const warm = await listLikeServer(svc);
	await warm.prefetch;
	expect(searches()).toHaveLength(2);
	expect(batches()).toHaveLength(4);
	expect(warm.rows.every((r) => r.detail)).toBe(true);
});

test('a new updatedAt fetches only that detail again', async () => {
	const world: World = { github: { 'example-org/a': specs(1, 23), 'example-org/b': specs(101, 4) } };
	const { svc, batches } = setup(world);
	await (await listLikeServer(svc)).prefetch;

	world.github!['example-org/a']!.find((s) => s.number === 7)!.updatedAt = new Date(Date.now() + 60_000).toISOString();
	advance(3_000);
	const next = await listLikeServer(svc);
	expect(next.rows.find((r) => r.number === 7)?.detail).toBeUndefined();
	await next.prefetch;
	expect(batches()).toHaveLength(5);
	expect(batches()[4]!.numbers).toEqual([7]);
	expect(batches()[4]!.name).toBe('a');
});

test('each host and repository gets its own batch', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) }, ghe: { 'example-org/app': specs(101, 3) } };
	const { svc, batches } = setup(world);
	await (await listLikeServer(svc)).prefetch;
	expect(batches()).toHaveLength(2);
	expect(batches().map((c) => [c.host, c.numbers])).toEqual([
		['github', [1, 2, 3]],
		['ghe', [101, 102, 103]],
	]);
	advance(3_000);
	const rows = (await listLikeServer(svc)).rows;
	expect(rows.map((r) => r.detail?.key).sort()).toEqual(rows.map((r) => r.key).sort());
});

test('a missing PR in a batch leaves only that row without details', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 4) } };
	const { svc, state, batches } = setup(world);
	state.missing.add(3); // pr2 comes back null, as GitHub answers a PR it cannot read
	const log = spyOn(console, 'error').mockImplementation(() => {});
	try {
		const { rows, prefetch } = await listLikeServer(svc);
		await prefetch;
		expect(batches()).toHaveLength(1);
		const key = (n: number) => rows.find((r) => r.number === n)!;
		expect(svc.cachedDetail(key(3).key, key(3).updatedAt)).toBeNull();
		for (const n of [1, 2, 4]) expect(svc.cachedDetail(key(n).key, key(n).updatedAt)?.number).toBe(n);
		expect(log).toHaveBeenCalledTimes(1);
	} finally {
		log.mockRestore();
	}
});

test('a failed batch leaves its rows without details and the list still returns', async () => {
	const world: World = { github: { 'example-org/a': specs(1, 23), 'example-org/b': specs(101, 4) } };
	const { svc, state, batches } = setup(world);
	state.failBatch = (c) => c.name === 'a' && c.numbers!.includes(1);
	const log = spyOn(console, 'error').mockImplementation(() => {});
	try {
		const { rows, prefetch } = await listLikeServer(svc);
		expect(rows).toHaveLength(27);
		await prefetch; // never rejects
		expect(batches()).toHaveLength(4);
		const lacking = rows.filter((r) => !svc.cachedDetail(r.key, r.updatedAt)).map((r) => r.number);
		expect(lacking.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		// The failure goes to the console, once for the call, and with its message.
		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]![0])).toContain('batch failed: HTTP 502');
	} finally {
		log.mockRestore();
	}
});

test('a failed batch does not mark the host as unreachable', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, state } = setup(world);
	state.failBatch = () => true;
	const log = spyOn(console, 'error').mockImplementation(() => {});
	try {
		const first = await listLikeServer(svc);
		await first.prefetch;
		// The host's list is a plain list: no error reaches the page, so its left-the-list check still runs.
		const again = await svc.listHost('github', []);
		expect(Object.keys(again).sort()).toEqual(['prs', 'throttled']);
		expect(again.prs).toHaveLength(3);
		expect(again.throttled).toBe(false);
	} finally {
		log.mockRestore();
	}
});

test('a failed batch leaves no unhandled rejection and no stuck request', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, state, batches } = setup(world);
	state.failBatch = () => true;
	const seen: unknown[] = [];
	const onRejection = (e: unknown) => void seen.push(e);
	const log = spyOn(console, 'error').mockImplementation(() => {});
	process.on('unhandledRejection', onRejection);
	try {
		const { rows } = await listLikeServer(svc); // the prefetch is not awaited
		await Bun.sleep(20);
		expect(batches()).toHaveLength(1);
		expect(seen).toEqual([]);

		// Nothing is stuck: the page's own call for one of its PRs sends exactly one query, and it succeeds.
		state.failBatch = () => false;
		const row = rows[1]!;
		const detail = await svc.getDetail(reqOf('github', row.owner, row.repo, row.number));
		expect(detail.number).toBe(row.number);
		expect(batches()).toHaveLength(2);
		expect(batches()[1]!.numbers).toEqual([row.number]);
	} finally {
		process.off('unhandledRejection', onRejection);
		log.mockRestore();
	}
});

test('a detail request during a batch shares the batch', async () => {
	const world: World = { github: { 'example-org/a': specs(1, 12), 'example-org/b': specs(101, 2) } };
	const { svc, state, batches } = setup(world);
	state.delayMs = 40;
	// Two list calls at the same time send each batch once.
	const [one, two] = await Promise.all([listLikeServer(svc), listLikeServer(svc)]);
	expect(batches()).toHaveLength(3);
	// A detail call for a PR in a pending batch sends nothing of its own, and gets the batch's detail.
	const row = one.rows.find((r) => r.number === 5)!;
	const detail = await svc.getDetail(reqOf('github', row.owner, row.repo, row.number));
	expect(batches()).toHaveLength(3);
	expect(detail.number).toBe(5);
	await Promise.all([one.prefetch, two.prefetch]);
	expect(svc.cachedDetail(row.key, row.updatedAt)).toBe(detail);
	expect(batches()).toHaveLength(3);
});

test('the first list does not wait for its batches and a detail request shares them', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, state, batches, calls } = setup(world);
	state.delayMs = 150;
	const { rows, prefetch } = await listLikeServer(svc);
	// The list is back with every PR. The batch is sent but not answered, and no row has a detail yet.
	expect(rows).toHaveLength(3);
	expect(batches()).toHaveLength(1);
	expect(state.answered).toBe(0);
	expect(rows.some((r) => r.detail)).toBe(false);

	const row = rows[1]!;
	const queriesBefore = calls.length;
	const detail = await svc.getDetail(reqOf('github', row.owner, row.repo, row.number));
	expect(calls).toHaveLength(queriesBefore);
	expect(detail.number).toBe(row.number);
	expect(state.answered).toBe(1);
	await prefetch;
	expect(svc.cachedDetail(row.key, row.updatedAt)).toBe(detail);
});

test('the low budget rule holds for batched details', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, rate, batches, searches } = setup(world);

	// Below 150, uncached PRs are not fetched either.
	rate.github = { remaining: 100, limit: 5000, resetAt: '', at: Date.now() };
	await (await listLikeServer(svc)).prefetch;
	expect(searches()).toHaveLength(1);
	expect(batches()).toHaveLength(0);

	// A cached detail is not refetched when the PR changed, and the old detail is not sent as current.
	rate.github.remaining = 5000;
	advance(3_000);
	const warm = await listLikeServer(svc);
	await warm.prefetch;
	expect(batches()).toHaveLength(1);
	rate.github.remaining = 100;
	const changed = warm.rows.map((r) => (r.number === 1 ? { ...r, updatedAt: new Date(Date.now() + 60_000).toISOString() } : r));
	await svc.prefetchDetails(changed);
	expect(batches()).toHaveLength(1);
	expect(svc.cachedDetail(changed[0]!.key, changed[0]!.updatedAt)).toBeNull();
	expect(svc.cachedDetail(changed[1]!.key, changed[1]!.updatedAt)?.number).toBe(2);
	// getDetail serves the cached detail at a low budget, as before.
	expect((await svc.getDetail(reqOf('github', 'example-org', 'app', 1))).throttled).toBe(true);
	expect(batches()).toHaveLength(1);
});

test('a prefetch stops sending batches when the budget falls below the floor', async () => {
	// Each answered batch costs 11 points (a batch of 10 PRs), and the host has 170: the floor is 150.
	const world: World = { github: { 'example-org/app': specs(1, 30) } };
	const { svc, rate, state, batches } = setup(world);
	rate.github = { remaining: 170, limit: 5000, resetAt: '', at: Date.now() };
	state.onAnswer = () => void (rate.github!.remaining -= 11);
	const { rows, prefetch } = await listLikeServer(svc);
	await prefetch;
	// Some PRs were fetched, and the prefetch left the host above the floor, so the rest is left to the per-row path.
	expect(batches().length).toBeGreaterThan(0);
	expect(batches().length).toBeLessThan(3);
	expect(rate.github.remaining).toBeGreaterThanOrEqual(150);
	const unfetched = rows.filter((r) => !svc.cachedDetail(r.key, r.updatedAt));
	expect(unfetched.length).toBeGreaterThan(0);
	// A PR that was not sent is not stuck: its own call still sends a query.
	const before = batches().length;
	await svc.getDetail(reqOf('github', unfetched[0]!.owner, unfetched[0]!.repo, unfetched[0]!.number));
	expect(batches()).toHaveLength(before + 1);
});

test('a duplicate key in one prefetch leaves no unhandled rejection', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, state, batches } = setup(world);
	state.failBatch = () => true;
	const seen: unknown[] = [];
	const onRejection = (e: unknown) => void seen.push(e);
	const log = spyOn(console, 'error').mockImplementation(() => {});
	process.on('unhandledRejection', onRejection);
	try {
		const rows = (await svc.listHost('github', [])).prs;
		await svc.prefetchDetails([...rows, rows[0]!]);
		await Bun.sleep(20);
		expect(seen).toEqual([]);
		expect(batches()).toHaveLength(1);
		expect(batches()[0]!.numbers).toEqual([1, 2, 3]);
	} finally {
		process.off('unhandledRejection', onRejection);
		log.mockRestore();
	}
});

test('a throttled list prefetches nothing', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, rate, batches } = setup(world);
	await svc.listHost('github', []); // a list is cached, and no detail is
	rate.github = { remaining: 200, limit: 5000, resetAt: '', at: Date.now() }; // under 300: the list is reused and marked throttled
	const { rows, prefetch } = await listLikeServer(svc);
	await prefetch;
	expect(rows).toHaveLength(3);
	expect(batches()).toHaveLength(0);
	// Without the mark, the same PRs are fetched: 200 points are enough for details.
	await svc.prefetchDetails(rows, { github: false });
	expect(batches()).toHaveLength(1);
});

test('in list mode a batch never refetches details less than 10 seconds old', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 2) } };
	const { svc, state, batches } = setup(world, 'list');
	const { rows, prefetch } = await listLikeServer(svc);
	await prefetch;
	expect(batches()).toHaveLength(1);

	// PR 1 changes 5 seconds later: its detail is under 10 seconds old, so it is not fetched again.
	advance(5_000);
	const bump = (n: number) => {
		const s = world.github!['example-org/app']!.find((x) => x.number === n)!;
		s.updatedAt = new Date(Date.now() + 60_000).toISOString();
		return s.updatedAt;
	};
	let current = rows.map((r) => (r.number === 1 ? { ...r, updatedAt: bump(1) } : r));
	await svc.prefetchDetails(current);
	expect(batches()).toHaveLength(1);
	advance(5_100);
	await svc.prefetchDetails(current);
	expect(batches()).toHaveLength(2);
	expect(batches()[1]!.numbers).toEqual([1]);

	// A failed batch holds its PRs for 60 seconds: the list sends nothing for them, then tries again.
	const log = spyOn(console, 'error').mockImplementation(() => {});
	try {
		state.failBatch = () => true;
		advance(10_100);
		current = current.map((r) => (r.number === 2 ? { ...r, updatedAt: bump(2) } : r));
		await svc.prefetchDetails(current);
		expect(batches()).toHaveLength(3);
		advance(30_000);
		await svc.prefetchDetails(current);
		advance(29_000);
		await svc.prefetchDetails(current);
		expect(batches()).toHaveLength(3);
		advance(1_100);
		await svc.prefetchDetails(current);
		expect(batches()).toHaveLength(4);
		expect(batches()[3]!.numbers).toEqual([2]);
	} finally {
		log.mockRestore();
	}
});

test('listed details carry the same base age as getDetail', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { svc, compares, batches } = setup(world);
	const { rows, prefetch } = await listLikeServer(svc);
	await prefetch;
	// One REST compare call for each head, next to the one batch query.
	expect(batches()).toHaveLength(1);
	expect(compares).toHaveLength(3);

	const listed = svc.cachedDetail(rows[0]!.key, rows[0]!.updatedAt)!;
	expect(listed.baseAge).toEqual({ against: 'main', mergeBaseAt: '2026-11-01T00:00:00Z', behindBy: 4, limitHours: null });
	const other = setup(world);
	const single = await other.svc.getDetail(reqOf('github', 'example-org', 'app', 1));
	expect(listed.baseAge).toEqual(single.baseAge);

	// The same head again (the PR changed, its head did not): the base age comes from the cache, with no new compare call.
	const changed = rows.map((r) => (r.number === 1 ? { ...r, updatedAt: new Date(Date.now() + 60_000).toISOString() } : r));
	advance(3_500);
	await svc.prefetchDetails(changed);
	expect(batches()).toHaveLength(2);
	expect(compares).toHaveLength(3);
});

test('the prefetch covers PRs that are not dormant or have a review request', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 4) } };
	const { svc, batches } = setup(world);
	const rows = (await svc.listHost('github', [])).prs; // the list only: no prefetch has started
	const old = new Date(Date.now() - 61 * 24 * 3600 * 1000).toISOString();
	const byNumber = (n: number) => rows.find((r) => r.number === n)!;
	await svc.prefetchDetails([
		{ ...byNumber(1), updatedAt: old }, // dormant, nobody asked
		{ ...byNumber(2), updatedAt: old, requestedFor: ['alice'] }, // dormant, a person asked
		{ ...byNumber(3), updatedAt: old, teamRequested: true }, // dormant, a team asked
		byNumber(4), // recent
	]);
	expect(batches()).toHaveLength(1);
	expect(batches()[0]!.numbers).toEqual([2, 3, 4]);
});

// ---------------------------------------------------------------------------
// getDetails and getDetail

test('getDetails batches the PRs of a repository and answers in order', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 12) } };
	const { svc, calls, batches } = setup(world);
	await svc.getDetail(reqOf('github', 'example-org', 'app', 3)); // cached: the batch leaves it out
	const before = calls.length;
	const req = (n: number) => reqOf('github', 'example-org', 'app', n, { maxAgeMs: 60_000 });
	const out = await Promise.allSettled(svc.getDetails([req(12), req(3), req(1), req(12), req(99)]));
	expect(calls.length - before).toBe(1);
	expect(batches().at(-1)!.numbers).toEqual([12, 1, 99]);
	expect(out.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
	expect(out.slice(0, 4).map((o) => (o as PromiseFulfilledResult<{ number: number }>).value.number)).toEqual([12, 3, 1, 12]);
	expect((out[4] as PromiseRejectedResult).reason).toBeInstanceOf(NotFoundError);
});

test('getDetail sends a batch of one', async () => {
	const world: World = {
		github: {
			'example-org/app': [
				spec(5, { head: 'feature/x', base: 'feature/base', up: { number: 4, title: 'Parent PR' }, down: [{ number: 6, title: 'Child PR' }, { number: 7, title: 'Other child' }] }),
				spec(8, { head: 'fix', base: 'main' }),
			],
		},
	};
	const { svc, batches } = setup(world);
	const stacked = await svc.getDetail({ host: 'github', owner: 'example-org', repo: 'app', number: 5, head: 'feature/x', base: 'feature/base' });
	expect(batches()).toHaveLength(1);
	expect(batches()[0]!.query).toBe(buildDetailBatch({ owner: 'example-org', name: 'app', prs: [{ number: 5, head: 'feature/x', base: 'feature/base' }] }).query);
	expect(batches()[0]!.vars).toEqual({ owner: 'example-org', name: 'app', n0: 5, h0: 'feature/x', b0: 'feature/base' });
	expect(stacked.parent).toEqual({ number: 4, title: 'Parent PR', url: 'https://github.com/example-org/app/pull/4', author: 'alice' });
	expect(stacked.stackedOnThis.map((p) => p.number)).toEqual([6, 7]);

	// A base that is a default branch has no `b0` and no parent lookup.
	const plain = await svc.getDetail({ host: 'github', owner: 'example-org', repo: 'app', number: 8, head: 'fix', base: 'main' });
	expect(batches()[1]!.vars).toEqual({ owner: 'example-org', name: 'app', n0: 8, h0: 'fix' });
	expect(batches()[1]!.query).not.toContain('up0:');
	expect(plain.parent).toBeNull();
});

test('getDetail without branches looks them up first', async () => {
	const world: World = { github: { 'example-org/app': [spec(5, { head: 'feature/x', base: 'feature/base', up: { number: 4, title: 'Parent PR' } })] } };
	const { svc, calls } = setup(world);
	const detail = await svc.getDetail({ host: 'github', owner: 'example-org', repo: 'app', number: 5 });
	expect(calls.map((c) => c.kind)).toEqual(['refs', 'batch']);
	expect(calls[1]!.vars).toEqual({ owner: 'example-org', name: 'app', n0: 5, h0: 'feature/x', b0: 'feature/base' });
	expect(detail.headRefName).toBe('feature/x');
	expect(detail.parent?.number).toBe(4);
});

test('getDetail of a missing PR is not found', async () => {
	const world: World = { github: { 'example-org/app': [spec(1)] } };
	const { svc, state } = setup(world);
	const err = await svc.getDetail(reqOf('github', 'example-org', 'app', 2)).catch((e: unknown) => e); // pr0: null
	expect(err).toBeInstanceOf(NotFoundError);
	expect((err as NotFoundError).status).toBe(404);

	// A repository that is not there at all answers the same.
	const noRepo: GhRunner = { rate: {}, get: () => Promise.reject(new Error('not used')), query: async <T>() => ({ repository: null }) as T };
	const gone = await createPrService(configFor(world), noRepo).getDetail(reqOf('github', 'example-org', 'app', 1)).catch((e: unknown) => e);
	expect(gone).toBeInstanceOf(NotFoundError);
	state.missing.add(1);
	expect(await svc.getDetail(reqOf('github', 'example-org', 'app', 1, { force: true })).catch((e: unknown) => e)).toBeInstanceOf(NotFoundError);
});

test('getDetail of a number below one is not found', async () => {
	const world: World = { github: { 'example-org/app': [spec(1)] } };
	const { svc, calls } = setup(world);
	for (const number of [0, -1, '0', 'abc', 1.5]) {
		const err = await svc.getDetail({ ...reqOf('github', 'example-org', 'app', 1), number }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(NotFoundError);
		expect((err as NotFoundError).status).toBe(404);
	}
	expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// MCP, over the same fake

const herdr = { links: async () => ({ available: false, reason: 'off', links: {}, scannedAt: '' }), focus: async () => {} };

async function callTool(handle: ReturnType<typeof createMcpHandler>, name: string, args: Record<string, unknown>) {
	const res = await handle(new Request('http://127.0.0.1/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
	const { result } = (await res.json()) as { result: { content: { text: string }[] } };
	return JSON.parse(result.content[0]!.text);
}

test('mcp get_pr reads details through the batch query', async () => {
	const world: World = { github: { 'example-org/app': [spec(5, { head: 'feature/x', base: 'feature/base', up: { number: 4, title: 'Parent PR' } })] } };
	const { gh, calls } = fakeGh(world);
	const handle = createMcpHandler(configFor(world), createPrService(configFor(world), gh), herdr);
	const out = await callTool(handle, 'get_pr', { repo: 'app', number: 5 });
	expect(out.title).toBe('PR 5');
	expect(out.stackedOn).toEqual({ number: 4, url: 'https://github.com/example-org/app/pull/4', title: 'Parent PR' });
	expect(calls.filter((c) => c.kind === 'refs')).toHaveLength(1);
	expect(calls.filter((c) => c.kind === 'batch')).toHaveLength(1);
});

test('mcp list_prs reads details through the batch query', async () => {
	const world: World = { github: { 'example-org/app': specs(1, 3) } };
	const { gh, batches } = fakeGh(world);
	const handle = createMcpHandler(configFor(world), createPrService(configFor(world), gh), herdr);
	const out = await callTool(handle, 'list_prs', {});
	expect(out.errors).toEqual([]);
	expect(out.pullRequests.map((p: { title: string }) => p.title).sort()).toEqual(['PR 1', 'PR 2', 'PR 3']);
	expect(out.pullRequests.some((p: { error?: string }) => p.error)).toBe(false);
	// One query for the three PRs, where each PR used to have its own.
	expect(batches()).toHaveLength(1);
	expect(batches()[0]!.numbers).toEqual([1, 2, 3]);
});
