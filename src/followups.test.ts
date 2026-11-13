import { describe, expect, test } from 'bun:test';
import { extractFollowUps, followUpLines, type FollowUpText } from './followups.ts';
import type { GhRunner } from './gh.ts';
import { createMcpHandler } from './mcp.ts';
import { createPrService, parsePrKey, prKey } from './prs.ts';
import type { Config } from './types.ts';

describe('followUpLines', () => {
	test('a heading that says the list does not block keeps every item under it', () => {
		const body = ['Looks good, approving.', '', 'Notes that do not block:', '- Rename `fooBar` to `fetchBar`.', '- Add a test for the empty list.', '1. Drop the unused import.'].join('\n');
		expect(followUpLines(body)).toEqual(['Rename `fooBar` to `fetchBar`.', 'Add a test for the empty list.', 'Drop the unused import.']);
	});

	test('markdown and bold headings work too, and the heading itself is not an item', () => {
		expect(followUpLines('## Optional\n\n- Cache the result')).toEqual(['Cache the result']);
		expect(followUpLines('**Non-blocking:**\n* Split this file')).toEqual(['Split this file']);
		expect(followUpLines('Fix these before the wiring PR:\n- Check the timeout')).toEqual(['Check the timeout']);
	});

	test('the list ends at the next paragraph', () => {
		const body = ['Optional:', '- Use a Set here', '', '- And sort the keys', '', 'Everything else is fine.', '- An unrelated list item'].join('\n');
		expect(followUpLines(body)).toEqual(['Use a Set here', 'And sort the keys']);
	});

	test('an indented line continues the item above it', () => {
		expect(followUpLines('Follow-ups:\n- Move the parser\n  into its own file\n- Done')).toEqual(['Move the parser into its own file', 'Done']);
	});

	test('a plain line that names later work is kept, on its own', () => {
		const body = 'Approving.\nWe can rename this in a follow-up.\nNice work on the tests.\nTODO: remove the flag once it ships';
		expect(followUpLines(body)).toEqual(['We can rename this in a follow-up.', 'TODO: remove the flag once it ships']);
	});

	test('"Optional:" at the start of a line counts', () => {
		expect(followUpLines('Optional: inline this helper.')).toEqual(['Optional: inline this helper.']);
	});

	test('quotes, tables, code blocks, HTML comments and ticked boxes are left out', () => {
		const body = [
			'> We should do this in a follow-up',
			'| 3 | deferred to a follow-up |',
			'```',
			'// TODO: not a follow-up, just code',
			'```',
			'<!-- template: list follow-ups here -->',
			'Follow-ups:',
			'- [x] Already done',
			'- [ ] Still open',
		].join('\n');
		expect(followUpLines(body)).toEqual(['Still open']);
	});

	test('text with nothing to match gives nothing', () => {
		expect(followUpLines('LGTM, ship it.\n\n- Tested locally\n- Works')).toEqual([]);
		expect(followUpLines(null)).toEqual([]);
	});
});

describe('extractFollowUps', () => {
	const text = (over: Partial<FollowUpText>): FollowUpText => ({
		author: 'bob',
		source: 'review',
		body: '',
		url: 'https://github.com/example-org/app/pull/1#r1',
		at: '2026-11-10T10:00:00Z',
		...over,
	});

	test("the author's own promises in the description are caught, and everything is in time order", () => {
		const list = extractFollowUps([
			text({ author: 'bob', body: 'Optional: add a metric', at: '2026-11-10T12:00:00Z' }),
			text({ author: 'carol', source: 'inline', path: 'src/app.ts', line: 12, body: 'Out of scope here, but worth a look.', at: '2026-11-10T11:00:00Z' }),
			text({ author: 'alice', source: 'description', body: 'Adds the parser.\n\nThe UI comes in a separate PR.', at: '2026-11-09T09:00:00Z' }),
		]);
		expect(list.map((f) => [f.author, f.source, f.text])).toEqual([
			['alice', 'description', 'The UI comes in a separate PR.'],
			['carol', 'inline', 'Out of scope here, but worth a look.'],
			['bob', 'review', 'Optional: add a metric'],
		]);
		expect(list[1]).toMatchObject({ path: 'src/app.ts', line: 12 });
	});

	test('the same line said twice counts once', () => {
		const list = extractFollowUps([text({ body: 'Follow-up: add docs' }), text({ source: 'comment', body: 'follow-up: add docs' })]);
		expect(list).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Fetching: the AI-review bot is skipped, PRs are batched, results are cached.

const config: Config = {
	me: 'alice',
	team: [{ id: 'alice', name: 'Alice Example', short: 'Alice', logins: { github: 'alice' } }],
	hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: 'review-bot' } },
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
};

const raw = (n: number, extra: Record<string, unknown> = {}) => ({
	url: `https://github.com/example-org/app/pull/${n}`,
	body: 'Adds a thing.',
	createdAt: '2026-11-10T09:00:00Z',
	author: { login: 'alice' },
	reviews: {
		nodes: [
			{ author: { login: 'bob' }, body: 'Approved.\n\nDoes not block:\n- Add a log line\n- Rename the flag', url: `https://github.com/example-org/app/pull/${n}#review-1`, submittedAt: '2026-11-10T10:00:00Z' },
		],
	},
	comments: {
		nodes: [
			{ author: { login: 'review-bot' }, body: 'Follow-ups:\n- Something the bot found', url: 'x', createdAt: '2026-11-10T10:30:00Z' },
			{ author: { login: 'helper[bot]' }, body: 'TODO: a bot chore', url: 'y', createdAt: '2026-11-10T10:31:00Z' },
			{ author: { login: 'alice' }, body: '@review-bot rejected: this belongs in a separate PR', url: 'w', createdAt: '2026-11-10T10:32:00Z' },
		],
	},
	reviewThreads: { nodes: [] },
	...extra,
});

function fakeGh() {
	const calls: number[][] = [];
	const gh: GhRunner = {
		rate: {},
		async query<T>(_host: string, query: string) {
			const numbers = [...query.matchAll(/pullRequest\(number:(\d+)\)/g)].map((m) => Number(m[1]));
			calls.push(numbers);
			await Bun.sleep(5);
			return { repository: Object.fromEntries(numbers.map((n, i) => [`p${i}`, n === 404 ? null : raw(n)])) } as T;
		},
		get: () => Promise.reject(new Error('not used')),
	};
	return { gh, calls };
}

const target = (number: number) => ({ host: 'github', owner: 'example-org', repo: 'app', number });

describe('getFollowUps', () => {
	test("skips the AI-review bot, other bots and replies to the bot, and keeps people's notes", async () => {
		const { gh } = fakeGh();
		const out = await createPrService(config, gh).getFollowUps([target(1)]);
		expect(out.followUps['github:example-org/app#1']!.map((f) => [f.author, f.text])).toEqual([
			['bob', 'Add a log line'],
			['bob', 'Rename the flag'],
		]);
		expect(out.errors).toEqual({});
	});

	test('asks for 10 PRs per query, shares calls in flight, and caches', async () => {
		const { gh, calls } = fakeGh();
		const prs = createPrService(config, gh);
		const many = Array.from({ length: 12 }, (_, i) => target(i + 1));
		const [a] = await Promise.all([prs.getFollowUps(many), prs.getFollowUps([target(3)])]);
		expect(calls.map((c) => c.length)).toEqual([10, 2]);
		expect(Object.keys(a.followUps)).toHaveLength(12);
		await prs.getFollowUps(many);
		expect(calls).toHaveLength(2);
	});

	test('a PR that is not found is an error, not an empty list', async () => {
		const { gh } = fakeGh();
		const out = await createPrService(config, gh).getFollowUps([target(404), target(5)]);
		expect(out.errors['github:example-org/app#404']).toMatch(/not found/);
		expect(out.followUps['github:example-org/app#5']).toHaveLength(2);
	});
});

describe('merged_prs over MCP', () => {
	test('each PR carries a follow-up count (0 when nothing matched), and the items on request', async () => {
		const now = new Date().toISOString();
		const gh: GhRunner = {
			rate: {},
			async query<T>(_host: string, query: string, vars: Record<string, unknown> = {}) {
				if (vars.q) {
					const node = (n: number) => ({ number: n, title: `PR ${n}`, url: `https://github.com/example-org/app/pull/${n}`, mergedAt: now, author: { login: 'alice' }, repository: { name: 'app', owner: { login: 'example-org' } } });
					return { search: { issueCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1), node(2)] } } as T;
				}
				const numbers = [...query.matchAll(/pullRequest\(number:(\d+)\)/g)].map((m) => Number(m[1]));
				// PR 1 has two follow-ups; PR 2 only a plain approval.
				const quiet = { ...raw(2), reviews: { nodes: [{ author: { login: 'bob' }, body: 'LGTM', url: 'z', submittedAt: now }] } };
				return { repository: Object.fromEntries(numbers.map((n, i) => [`p${i}`, n === 1 ? raw(1) : quiet])) } as T;
			},
			get: () => Promise.reject(new Error('not used')),
		};
		const herdr = { links: async () => ({ available: false, reason: 'off', links: {}, scannedAt: now }), focus: async () => {} };
		const handle = createMcpHandler(config, createPrService(config, gh), herdr);
		const call = async (args: Record<string, unknown>) => {
			const res = await handle(new Request('http://127.0.0.1/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merged_prs', arguments: args } }) }));
			const { result } = (await res.json()) as { result: { content: { text: string }[] } };
			return JSON.parse(result.content[0]!.text);
		};
		const out = await call({ range: 'last-30-days' });
		const counts = Object.fromEntries(out.pullRequests.map((p: { ref: string; followUps: number }) => [p.ref, p.followUps]));
		expect(counts).toEqual({ 'app#1': 2, 'app#2': 0 });
		expect(out.pullRequests[0].followUpItems).toBeUndefined();

		const withItems = await call({ range: 'last-30-days', include_follow_ups: true });
		const one = withItems.pullRequests.find((p: { ref: string }) => p.ref === 'app#1');
		expect(one.followUpItems.map((f: { who: string; where: string; text: string }) => [f.who, f.where, f.text])).toEqual([
			['bob', 'review', 'Add a log line'],
			['bob', 'review', 'Rename the flag'],
		]);
		expect(withItems.pullRequests.find((p: { ref: string }) => p.ref === 'app#2').followUpItems).toBeUndefined();
	});
});

test('parsePrKey reads back what prKey writes, and nothing else', () => {
	expect(parsePrKey(prKey('my-host', 'example-org', 'app.js', 42))).toEqual({ host: 'my-host', owner: 'example-org', repo: 'app.js', number: 42 });
	expect(parsePrKey('my-host:example-org/app')).toBeNull();
	expect(parsePrKey('my-host:example-org/a b#1')).toBeNull();
});
