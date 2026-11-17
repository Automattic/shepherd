// Whether the AI-review bot's last review covers the head, and what keeps an approved PR from going out.
// The PR is the contract case `ai-review-behind`, changed per test. Run with `bun test`.

import { expect, test } from 'bun:test';
import { loadCases } from './contract.ts';
import type { GhRunner } from './gh.ts';
import { createMcpHandler } from './mcp.ts';
import { createPrService } from './prs.ts';
import { hasBlockers } from './ready.ts';
import type { Config, PrDetail } from './types.ts';

interface RawComment {
	author: { __typename: string; login: string } | null;
	createdAt: string;
	updatedAt: string;
}
interface RawPr {
	mergeable: string;
	statusCheckRollup: { state: string } | null;
	comments: { nodes: RawComment[] };
	reviews: { nodes: { author: { __typename: string; login: string } | null; submittedAt: string | null }[] };
	commits: { nodes: unknown[] };
	reviewThreads: { nodes: unknown[] };
}

const base = (await loadCases()).find((c) => c.name === 'ai-review-behind')!;
const BOT = { __typename: 'Bot', login: 'review-bot' };
const config = (bot: string | null): Config => ({
	me: 'alice',
	team: [{ id: 'alice', name: 'Alice Example', short: 'Alice', logins: { ghe: 'alice' } }],
	hosts: { ghe: { hostname: 'github.example.com', label: 'GHE', bot } },
	repos: [{ host: 'ghe', owner: 'example-org', name: 'app', short: 'app' }],
});

/** A `gh` that answers the detail query with the case, after `change` edited its PR. Searches find nothing, and follow-ups are not there. */
function fakeGh(change: (pr: RawPr) => void = () => {}): GhRunner {
	const data = structuredClone(base.data);
	change(data.repository.pr0 as RawPr);
	return {
		rate: {},
		async query<T>(_host: string, query: string) {
			if (query.includes('search(')) return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } as T;
			if (query.includes('...DetailPr')) return structuredClone(data) as T;
			if (query.includes('p0:')) return { repository: { p0: null } } as T;
			return { repository: { pullRequest: { headRefName: 'feature/review-behind', baseRefName: 'trunk' } } } as T;
		},
		get: () => Promise.reject(new Error('no compare in this test')),
	};
}

const detail = (change?: (pr: RawPr) => void, bot: string | null = 'review-bot'): Promise<PrDetail> =>
	createPrService(config(bot), fakeGh(change)).getDetail({ host: 'ghe', owner: 'example-org', repo: 'app', number: 112, head: 'feature/review-behind', base: 'trunk' });

test('a review older than the newest commit is not current', async () => {
	const d = await detail();
	// The newest comment of the bot, by creation, was last edited at 10:05, and the newest commit is from 11:00.
	// Its older comment was touched at 12:30, which must not count as a review of the head.
	expect(d.lastCommitAt).toBe('2026-11-10T11:00:00Z');
	expect(d.bot).toMatchObject({ reviewedAt: '2026-11-10T10:05:00Z', current: false });
});

/** The bot edits its newest comment after the newest commit, so its review covers the head. */
const current = (pr: RawPr) => {
	pr.comments.nodes[1]!.updatedAt = '2026-11-10T11:20:00Z';
};
/** A PR with a current review, and one more change. */
const and = (change: (pr: RawPr) => void) => (pr: RawPr) => {
	current(pr);
	change(pr);
};

test('a bot that edits its newest comment after the push has reviewed the head', async () => {
	const d = await detail(current);
	expect(d.bot).toMatchObject({ reviewedAt: '2026-11-10T11:20:00Z', current: true });
});

test('a new comment or a new review of the bot after the push is current', async () => {
	const comment = await detail((pr) => {
		pr.comments.nodes.push({ author: BOT, createdAt: '2026-11-10T11:10:00Z', updatedAt: '2026-11-10T11:10:00Z' });
	});
	expect(comment.bot).toMatchObject({ reviewedAt: '2026-11-10T11:10:00Z', current: true });
	// The bot's login matches without case, as GitHub logins do.
	const review = await detail((pr) => {
		pr.reviews.nodes.push({ author: { __typename: 'Bot', login: 'Review-Bot' }, submittedAt: '2026-11-10T11:00:00Z' });
	});
	expect(review.bot).toMatchObject({ reviewedAt: '2026-11-10T11:00:00Z', current: true });
});

test('a bot that has not reviewed the PR is neither current nor behind', async () => {
	const d = await detail((pr) => {
		pr.comments.nodes = pr.comments.nodes.filter((c) => c.author?.login !== 'review-bot');
		pr.reviews.nodes = pr.reviews.nodes.filter((r) => r.author?.login !== 'review-bot');
	});
	expect(d.bot).toMatchObject({ reviewedAt: null, current: null });
	expect(hasBlockers(d)).toBe(false);
});

test('a review of a PR with no commits in the answer is current', async () => {
	const d = await detail((pr) => {
		pr.commits.nodes = [];
	});
	expect(d.lastCommitAt).toBeNull();
	expect(d.bot).toMatchObject({ reviewedAt: '2026-11-10T10:05:00Z', current: true });
});

test('a host with no bot has no review to be behind', async () => {
	const d = await detail(undefined, null);
	expect(d.bot).toBeNull();
	expect(hasBlockers(d)).toBe(false);
});

test('an approved PR is blocked while the review is behind the head or a fix thread is open', async () => {
	const withThread = (body: string, isResolved = false) =>
		and((pr) => {
			pr.reviewThreads.nodes.push({
				isResolved,
				isOutdated: false,
				path: 'src/a.ts',
				line: 1,
				comments: { nodes: [{ author: BOT, body, url: 'https://github.example.com/example-org/app/pull/112#discussion_r1', createdAt: '2026-11-10T11:20:00Z' }] },
			});
		});
	expect(hasBlockers(await detail())).toBe(true); // behind
	expect(hasBlockers(await detail(current))).toBe(false);
	expect(hasBlockers(await detail(withThread('**Missing null check** · fix here · high')))).toBe(true);
	expect(hasBlockers(await detail(withThread('**Missing null check** · fix here · high', true)))).toBe(false); // resolved
	expect(hasBlockers(await detail(withThread('**Rename variable** · nit · low')))).toBe(false); // minor
	// Conflicts and failed checks block as before, and pending checks do not.
	expect(hasBlockers(await detail(and((pr) => void (pr.mergeable = 'CONFLICTING'))))).toBe(true);
	for (const [state, blocked] of [['FAILURE', true], ['ERROR', true], ['PENDING', false], [null, false]] as const) {
		const d = await detail(and((pr) => void (pr.statusCheckRollup = state ? { state } : null)));
		expect([state, hasBlockers(d)]).toEqual([state, blocked]);
	}
});

test('mcp get_pr says whether the review covers the head', async () => {
	const herdr = { links: async () => ({ available: false, reason: 'off', links: {}, scannedAt: '' }), focus: async () => {} };
	const call = async (cfg: Config) => {
		const handle = createMcpHandler(cfg, createPrService(cfg, fakeGh()), herdr);
		const res = await handle(
			new Request('http://127.0.0.1/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_pr', arguments: { repo: 'app', number: 112 } } }) })
		);
		const { result } = (await res.json()) as { result: { content: { text: string }[] } };
		return JSON.parse(result.content[0]!.text) as { aiReview: unknown };
	};
	expect((await call(config('review-bot'))).aiReview).toEqual({
		bot: 'review-bot',
		unresolved: 0,
		fix: 0,
		minor: 0,
		onOutdatedCode: 0,
		current: false,
		reviewedAt: '2026-11-10T10:05:00Z',
		headCommitAt: '2026-11-10T11:00:00Z',
	});
	expect((await call(config(null))).aiReview).toBeNull();
});
