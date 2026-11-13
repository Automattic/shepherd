import { describe, expect, test } from 'bun:test';
import { extractFollowUps, followUpLines, needingFollowUp, type FollowUpText } from './followups.ts';
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

	test('ordinary prose that shares the words is not a follow-up', () => {
		const body = [
			'Follow-up to #123. This PR:',
			'- Adds the cache',
			'- Removes the flag',
			'Makes the fetch non-blocking so the page stays responsive.',
			'Adds the todo list screen.',
			'- [ ] I tested this before merging',
		].join('\n');
		expect(followUpLines(body)).toEqual([]);
	});

	test('those words still count as a heading, or at the start of a line', () => {
		expect(followUpLines('Before merging:\n- Rebase')).toEqual(['Rebase']);
		expect(followUpLines('Nits:\n- Rename foo')).toEqual(['Rename foo']);
		expect(followUpLines('Non-blocking: the name is confusing')).toEqual(['Non-blocking: the name is confusing']);
	});

	test('"a PR" in ordinary prose is not a follow-up', () => {
		const body = [
			'Shepherd then searches for open PRs that request one of those teams. Such a PR waits on every person in `team`.',
			'Some teams mark a PR as ready for review by requesting a GitHub team.',
			'- a PR closed without merging',
			'`CONTRIBUTING.md` asks contributors to run `bun test` before opening a PR.',
			'Opens a new PR for each repo.',
		].join('\n');
		expect(followUpLines(body)).toEqual([]);
		expect(followUpLines('The UI comes in another PR.')).toEqual(['The UI comes in another PR.']);
	});

	test('a lead-in of more than one sentence that says the list does not block keeps every item, not the lead-in', () => {
		const body = [
			'What I checked:',
			'- The offsets are clamped.',
			'',
			'These items do not block this PR. Fix them in this PR or before the wiring PR makes the ability reachable:',
			'',
			'1. **`instructions` claims too much.** Say when the list is empty.',
			'2. **The `\\Throwable` catch logs only the class name.** Log the message too.',
			'',
			'Nice work.',
		].join('\n');
		expect(followUpLines(body)).toEqual(['**`instructions` claims too much.** Say when the list is empty.', '**The `\\Throwable` catch logs only the class name.** Log the message too.']);
	});

	test('a lead-in needs words that say the list does not block', () => {
		expect(followUpLines('Tested before merging. Steps:\n- Run the suite\n- Open the page')).toEqual([]);
		expect(followUpLines('Split out of #12. Changes:\n- Adds the cache')).toEqual([]);
	});

	test('a lead-in with no list under it still counts on its own when its words do', () => {
		expect(followUpLines("This doesn't block. We can rename it in a follow-up:\n\nThanks!")).toEqual(["This doesn't block. We can rename it in a follow-up:"]);
		expect(followUpLines('Nits are fine. Here is the plan:\n\nShip it.')).toEqual([]);
	});

	test('"out of scope" explains what the work leaves out; it asks nothing', () => {
		const body = '## Risks\n\n- Follow-up for Domains: reorder `disable_dnssec()`.\n\n## Out of scope\n\n- No REST route changes.\n- `show_in_rest` is not set.\n\nThis PR does not add a restore ability (out of scope in the ticket).';
		expect(followUpLines(body)).toEqual(['Follow-up for Domains: reorder `disable_dnssec()`.']);
		expect(followUpLines('Out of scope here, but worth a look.')).toEqual([]);
		expect(followUpLines('Out of scope:\n- No REST route changes.')).toEqual([]);
	});

	test('an empty template section gives nothing', () => {
		expect(followUpLines('## Follow-ups\n- None\n- N/A')).toEqual([]);
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
			text({ author: 'carol', source: 'inline', path: 'src/app.ts', line: 12, body: 'Worth a look in a follow-up.', at: '2026-11-10T11:00:00Z' }),
			text({ author: 'alice', source: 'description', body: 'Adds the parser.\n\nThe UI comes in a separate PR.', at: '2026-11-09T09:00:00Z' }),
		]);
		expect(list.map((f) => [f.author, f.source, f.text])).toEqual([
			['alice', 'description', 'The UI comes in a separate PR.'],
			['carol', 'inline', 'Worth a look in a follow-up.'],
			['bob', 'review', 'Optional: add a metric'],
		]);
		expect(list[1]).toMatchObject({ path: 'src/app.ts', line: 12 });
	});

	test('the same line said twice counts once', () => {
		const list = extractFollowUps([text({ body: 'Follow-up: add docs' }), text({ source: 'comment', body: 'follow-up: add docs' })]);
		expect(list).toHaveLength(1);
	});

	test('an ask repeated after the code changed is live again', () => {
		const list = extractFollowUps([
			text({ body: 'Optional: add docs', stale: true, at: '2026-11-10T10:00:00Z' }),
			text({ body: 'Optional: add docs', at: '2026-11-11T10:00:00Z' }),
			text({ body: 'Optional: cache it', stale: true }),
		]);
		expect(list.map((f) => [f.text, f.stale])).toEqual([
			['Optional: add docs', false],
			['Optional: cache it', true],
		]);
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
	headRefOid: 'head',
	// The last commit came before every review and comment, so nothing here is stale.
	commits: { nodes: [{ commit: { committedDate: '2026-11-10T09:30:00Z' } }] },
	reviews: {
		nodes: [
			{
				author: { login: 'bob' },
				body: 'Approved.\n\nDoes not block:\n- Add a log line\n- Rename the flag',
				url: `https://github.com/example-org/app/pull/${n}#review-1`,
				submittedAt: '2026-11-10T10:00:00Z',
				commit: { oid: 'head' },
			},
		],
	},
	comments: {
		nodes: [
			{ author: { login: 'review-bot' }, body: 'Follow-ups:\n- Something the bot found', url: 'x', createdAt: '2026-11-10T10:30:00Z' },
			{ author: { login: 'helper[bot]' }, body: 'TODO: a bot chore', url: 'y', createdAt: '2026-11-10T10:31:00Z' },
			{ author: { login: 'alice' }, body: '@review-bot rejected: this belongs in a separate PR', url: 'w', createdAt: '2026-11-10T10:32:00Z' },
			{ author: { login: 'carol' }, body: '@review-botanist this needs a decision', url: 'v', createdAt: '2026-11-10T10:33:00Z' },
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
			['carol', '@review-botanist this needs a decision'],
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

	test('asks the code may have done since are stale, and resolved threads are dropped', async () => {
		const later = raw(7, {
			headRefOid: 'final',
			commits: { nodes: [{ commit: { committedDate: '2026-11-11T12:00:00Z' } }] },
			body: 'Adds a thing.\n\nThe UI comes in a separate PR.',
			reviews: {
				nodes: [
					// Approved an older commit; a cleanup commit followed (wpcom#258402).
					{ author: { login: 'bob' }, body: 'The duplicated helper is fair cleanup but does not block.', url: 'r1', submittedAt: '2026-11-10T10:00:00Z', commit: { oid: 'old' } },
					{ author: { login: 'dan' }, body: 'Optional: add a metric', url: 'r2', submittedAt: '2026-11-11T13:00:00Z', commit: { oid: 'final' } },
				],
			},
			comments: {
				nodes: [
					{ author: { login: 'carol' }, body: 'TODO: drop the flag', url: 'c1', createdAt: '2026-11-11T11:00:00Z' },
					{ author: { login: 'carol' }, body: 'Rename it in a follow-up.', url: 'c2', createdAt: '2026-11-11T14:00:00Z' },
				],
			},
			reviewThreads: {
				nodes: [
					{ isResolved: true, isOutdated: false, path: 'a.ts', line: 1, comments: { nodes: [{ author: { login: 'dan' }, body: 'Optional: inline this', url: 't1', createdAt: '2026-11-11T13:00:00Z' }] } },
					{ isResolved: false, isOutdated: true, path: 'b.ts', line: 2, comments: { nodes: [{ author: { login: 'dan' }, body: 'Optional: split this', url: 't2', createdAt: '2026-11-11T13:00:00Z' }] } },
				],
			},
		});
		const gh: GhRunner = { rate: {}, query: async <T,>() => ({ repository: { p0: later } }) as T, get: () => Promise.reject(new Error('not used')) };
		const out = await createPrService(config, gh).getFollowUps([target(7)]);
		expect(out.followUps['github:example-org/app#7']!.map((f) => [f.text, f.stale])).toEqual([
			['The UI comes in a separate PR.', false], // the description describes the final code
			['The duplicated helper is fair cleanup but does not block.', true], // review of an older commit
			['TODO: drop the flag', true], // before the last commit
			['Optional: add a metric', false],
			['Optional: split this', true], // outdated thread
			['Rename it in a follow-up.', false],
		]);
	});

	test('a PR that is not found is an error, not an empty list', async () => {
		const { gh } = fakeGh();
		const out = await createPrService(config, gh).getFollowUps([target(404), target(5)]);
		expect(out.errors['github:example-org/app#404']).toMatch(/not found/);
		expect(out.followUps['github:example-org/app#5']).toHaveLength(3);
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
				// PR 1 has three follow-ups; PR 2 a plain approval, and an ask on an older commit that may be done.
				const quiet = {
					...raw(2),
					reviews: {
						nodes: [
							{ author: { login: 'bob' }, body: 'LGTM', url: 'z', submittedAt: now, commit: { oid: 'head' } },
							{ author: { login: 'dan' }, body: 'Optional: add a metric', url: 'z2', submittedAt: now, commit: { oid: 'old' } },
						],
					},
					comments: { nodes: [] },
				};
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
		expect(counts).toEqual({ 'app#1': 3, 'app#2': 0 });
		expect(out.pullRequests[0].followUpItems).toBeUndefined();

		const withItems = await call({ range: 'last-30-days', include_follow_ups: true });
		const one = withItems.pullRequests.find((p: { ref: string }) => p.ref === 'app#1');
		expect(one.followUpItems.map((f: { who: string; where: string; text: string }) => [f.who, f.where, f.text])).toEqual([
			['bob', 'review', 'Add a log line'],
			['bob', 'review', 'Rename the flag'],
			['carol', 'comment', '@review-botanist this needs a decision'],
		]);
		expect(withItems.pullRequests.find((p: { ref: string }) => p.ref === 'app#2').followUpItems).toBeUndefined();
	});
});

test('parsePrKey reads back what prKey writes, and nothing else', () => {
	expect(parsePrKey(prKey('my-host', 'example-org', 'app.js', 42))).toEqual({ host: 'my-host', owner: 'example-org', repo: 'app.js', number: 42 });
	expect(parsePrKey('my-host:example-org/app')).toBeNull();
	expect(parsePrKey('my-host:example-org/a b#1')).toBeNull();
});

describe('needingFollowUp (the Shipped "Needs follow-up" chip)', () => {
	const prs = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
	const item = { text: 'Optional: add a test', stale: false };

	test('keeps only PRs with at least one follow-up, in order, and counts them', () => {
		const fu = new Map([['a', [item, item]], ['b', []], ['c', [item]], ['d', []]]);
		const out = needingFollowUp(prs, fu);
		expect(out.prs.map((p) => p.key)).toEqual(['a', 'c']);
		expect(out.loading).toBe(false);
	});

	test('nothing matched means an empty list and a count of 0', () => {
		const out = needingFollowUp(prs, new Map(prs.map((p) => [p.key, []])));
		expect(out).toEqual({ prs: [], loading: false });
	});

	test('a PR whose follow-ups may all be done already is left out', () => {
		const fu = new Map([['a', [{ ...item, stale: true }]], ['b', [{ ...item, stale: true }, item]], ['c', []], ['d', []]]);
		expect(needingFollowUp(prs, fu).prs.map((p) => p.key)).toEqual(['b']);
	});

	test('says it is still loading while a PR has no answer, but not for one that failed', () => {
		const fu = new Map([['a', [item]], ['b', []]]);
		expect(needingFollowUp(prs, fu).loading).toBe(true);
		expect(needingFollowUp(prs, fu, new Set(['c', 'd'])).loading).toBe(false);
		expect(needingFollowUp(prs, fu).prs.map((p) => p.key)).toEqual(['a']);
	});
});
