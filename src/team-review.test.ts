// Review-team requests: the list search and the "waiting on" rule. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import type { GhRunner } from './gh.ts';
import type { HerdrService } from './herdr.ts';
import { createMcpHandler } from './mcp.ts';
import { createPrService, type PrService } from './prs.ts';
import type { Config, LightPr, PrDetail, TeamMember } from './types.ts';
import { waitReasons } from './waiting.ts';

const alice: TeamMember = { id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice' } };
const bob: TeamMember = { id: 'bob', name: 'Bob', short: 'Bob', logins: { github: 'bob' } };

function pr(over: Partial<PrDetail> = {}): PrDetail {
	return {
		key: 'github:example-org/app#1',
		host: 'github',
		owner: 'example-org',
		repo: 'app',
		number: 1,
		title: 'Add a thing',
		url: 'https://github.com/example-org/app/pull/1',
		state: 'OPEN',
		mergedAt: null,
		isDraft: false,
		updatedAt: '2026-01-02T00:00:00Z',
		createdAt: '2026-01-01T00:00:00Z',
		headRefName: 'add-thing',
		baseRefName: 'main',
		author: { login: 'alice', name: 'Alice' },
		mergeable: 'MERGEABLE',
		reviewDecision: 'REVIEW_REQUIRED',
		checks: null,
		size: { additions: 1, deletions: 0, files: 1 },
		requested: { users: [], teams: [{ slug: 'reviewers', combinedSlug: 'example-org/reviewers', name: 'Reviewers', reviewTeam: true }] },
		reviews: [],
		bot: null,
		participants: [],
		authorLastActive: null,
		lastActivity: null,
		lastCommitAt: null,
		linear: [],
		refs: [],
		hashRefs: [],
		parent: null,
		stackedOnThis: [],
		baseAge: null,
		fetchedAt: '2026-01-02T00:00:00Z',
		...over,
	};
}

describe('waitReasons with review teams', () => {
	const otherTeam = { users: [], teams: [{ slug: 'other', combinedSlug: 'example-org/other', name: 'Other', reviewTeam: false }] };

	test('a request to a team that is not a review team counts for nobody', () => {
		expect(waitReasons(pr({ requested: otherTeam }), bob)).toEqual([]);
	});

	test('a review-team request waits on members, not on the author', () => {
		expect(waitReasons(pr(), bob)).toEqual(['team']);
		expect(waitReasons(pr(), alice)).toEqual([]);
	});

	test('a member whose approval stands drops it; a dismissed approval brings it back', () => {
		expect(waitReasons(pr({ reviews: [{ login: 'bob', state: 'APPROVED', submittedAt: '2026-01-02T00:00:00Z' }] }), bob)).toEqual([]);
		expect(waitReasons(pr({ reviews: [{ login: 'bob', state: 'DISMISSED', submittedAt: '2026-01-02T00:00:00Z' }] }), bob)).toEqual(['team']);
	});

	test('a direct request and a team request give one reason', () => {
		const both = { users: [{ login: 'bob', name: 'Bob' }], teams: pr().requested.teams };
		expect(waitReasons(pr({ requested: both }), bob)).toEqual(['requested']);
	});

	test('drafts are left out', () => {
		expect(waitReasons(pr({ isDraft: true }), bob)).toEqual([]);
	});

	test('a member with no login on the host is not counted', () => {
		const carol: TeamMember = { id: 'carol', name: 'Carol', short: 'Carol', logins: { work: 'carol' } };
		expect(waitReasons(pr(), carol)).toEqual([]);
	});
});

describe('listHost with review teams', () => {
	const node = (number: number, author: string) => ({
		number,
		title: `PR ${number}`,
		url: `https://github.com/example-org/app/pull/${number}`,
		isDraft: false,
		updatedAt: '2026-01-02T00:00:00Z',
		createdAt: '2026-01-01T00:00:00Z',
		headRefName: `b${number}`,
		baseRefName: 'main',
		author: { login: author },
		repository: { name: 'app', owner: { login: 'example-org' } },
	});

	function service(reviewTeams?: string[]) {
		const queries: string[] = [];
		const gh: GhRunner = {
			rate: {},
			get: () => Promise.reject(new Error('not used')),
			query: async <T>(_host: string, _q: string, vars?: Record<string, unknown>) => {
				const q = String(vars?.q);
				queries.push(q);
				const nodes = q.includes('team-review-requested:')
					? [node(1, 'alice'), node(2, 'outsider')]
					: q.includes('user-review-requested:bob') || q.includes('author:')
						? [node(1, 'alice')]
						: [];
				return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } as T;
			},
		};
		const config: Config = {
			me: 'alice',
			team: [alice, bob],
			hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null, ...(reviewTeams ? { reviewTeams } : {}) } },
			repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
		};
		return { prs: createPrService(config, gh), queries };
	}

	test('without reviewTeams, no team search runs', async () => {
		const { prs, queries } = service();
		const { prs: list } = await prs.listHost('github', ['bob']);
		expect(queries.some((q) => q.includes('team-review-requested:'))).toBe(false);
		expect(list.some((p) => p.teamRequested)).toBe(false);
	});

	test('team-requested PRs are listed once, marked with the team', async () => {
		const { prs, queries } = service(['example-org/reviewers']);
		const { prs: list } = await prs.listHost('github', ['bob']);
		expect(queries).toContain('is:pr is:open draft:false repo:example-org/app team-review-requested:example-org/reviewers');
		expect(list.map((p) => p.number).sort()).toEqual([1, 2]);
		const one = list.find((p) => p.number === 1)!;
		expect(one.teamRequested).toBe(true);
		expect(one.requestedFor).toEqual(['bob']);
		expect(one.authoredByTeam).toBe(true);
		expect(list.find((p) => p.number === 2)!.authoredByTeam).toBe(false);
	});
});

describe('MCP tools with review teams', () => {
	const now = new Date().toISOString();
	const idle = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
	const light = (number: number, author: string, flags: { authoredByTeam: boolean; teamRequested: boolean }): LightPr => ({
		key: `github:example-org/app#${number}`,
		host: 'github',
		owner: 'example-org',
		repo: 'app',
		number,
		title: `PR ${number}`,
		url: `https://github.com/example-org/app/pull/${number}`,
		isDraft: false,
		updatedAt: now,
		createdAt: now,
		headRefName: `b${number}`,
		baseRefName: 'main',
		author: { login: author, name: null },
		requestedFor: [],
		...flags,
	});
	const nobody = { users: [], teams: [] };

	// 1: the team's, review team requested. 2: an outsider's, review team requested.
	// 3: the team's, no team request. 4: the search saw a request that has since been cleared.
	const lights = [
		light(1, 'alice', { authoredByTeam: true, teamRequested: true }),
		light(2, 'outsider', { authoredByTeam: false, teamRequested: true }),
		light(3, 'alice', { authoredByTeam: true, teamRequested: false }),
		light(4, 'outsider', { authoredByTeam: false, teamRequested: true }),
	];
	const details: Record<number, PrDetail> = {
		1: pr({ number: 1, updatedAt: now }),
		2: pr({ number: 2, updatedAt: now, author: { login: 'outsider', name: null } }),
		3: pr({ number: 3, updatedAt: now, requested: nobody }),
		4: pr({ number: 4, updatedAt: now, author: { login: 'outsider', name: null }, requested: nobody }),
		5: pr({ number: 5, updatedAt: now, isDraft: true }),
		6: pr({ number: 6, updatedAt: idle, author: { login: 'outsider', name: null } }),
		7: pr({ number: 7, updatedAt: idle, requested: nobody }),
	};
	// 6: an outsider's PR that requests the review team but has been idle past the 60-day dormant cut-off. 7: the team's, idle, no team request.
	const idleLights = [
		{ ...light(6, 'outsider', { authoredByTeam: false, teamRequested: true }), updatedAt: idle },
		{ ...light(7, 'alice', { authoredByTeam: true, teamRequested: false }), updatedAt: idle },
	];
	const numbers = (prs: { number: number }[]) => prs.map((p) => p.number).sort((a, b) => a - b);

	function handler(reviewTeams?: string[], opts: { extra?: LightPr[]; failing?: number[] } = {}) {
		const config: Config = {
			me: 'alice',
			team: [alice, bob],
			hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null, ...(reviewTeams ? { reviewTeams } : {}) } },
			repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
		};
		const prs: PrService = {
			hostKeys: ['github'],
			listHost: async () => ({ prs: [...lights, ...(opts.extra ?? [])].map((l) => ({ ...l, requestedFor: [] })), throttled: false }),
			getDetail: async (req) => {
				if (opts.failing?.includes(Number(req.number))) throw new Error('proxy timeout');
				return details[Number(req.number)]!;
			},
			listMerged: async () => ({ prs: [], total: 0 }),
		};
		const herdr: HerdrService = {
			links: async () => ({ available: false, reason: 'off', links: {}, scannedAt: now }),
			focus: async () => {},
		};
		return createMcpHandler(config, prs, herdr);
	}

	async function call(h: ReturnType<typeof handler>, name: string, args: Record<string, unknown> = {}) {
		const res = await h(
			new Request('http://127.0.0.1/mcp', {
				method: 'POST',
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
			})
		);
		const { result } = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
		const text = result.content[0]!.text;
		return result.isError ? { error: text } : JSON.parse(text);
	}

	test('list_prs marks which requested teams are review teams', async () => {
		const out = await call(handler(['example-org/reviewers']), 'list_prs');
		const one = out.pullRequests.find((p: { number: number }) => p.number === 1);
		expect(one.reviewTeamRequested).toBe(true);
		expect(one.waitingOnReviewFrom.reviewTeams).toEqual(['example-org/reviewers']);
		const three = out.pullRequests.find((p: { number: number }) => p.number === 3);
		expect(three.reviewTeamRequested).toBe(false);
		// Without the filter, PRs by people outside the team stay out, as before.
		expect(out.pullRequests.map((p: { number: number }) => p.number).sort()).toEqual([1, 3]);
	});

	test('review_team_requested lists team requests by anyone, and drops cleared ones', async () => {
		const out = await call(handler(['example-org/reviewers']), 'list_prs', { review_team_requested: true });
		expect(out.pullRequests.map((p: { number: number }) => p.number).sort()).toEqual([1, 2]);
		expect(out.matchedBeforeLimit).toBe(2);
	});

	test('a draft never counts as review-team requested', async () => {
		const out = await call(handler(['example-org/reviewers']), 'get_pr', { repo: 'app', number: 1 });
		expect(out.reviewTeamRequested).toBe(true);
		const draft = await call(handler(['example-org/reviewers']), 'get_pr', { repo: 'app', number: 5 });
		expect(draft.reviewTeamRequested).toBe(false);
	});

	test('the team tool shows the review teams per host', async () => {
		expect((await call(handler(['example-org/reviewers']), 'team')).reviewTeams).toEqual({ 'github.com': ['example-org/reviewers'] });
		expect((await call(handler(), 'team')).reviewTeams).toBeNull();
	});

	test('the filter explains itself when no review teams are set', async () => {
		const out = await call(handler(), 'list_prs', { review_team_requested: true });
		expect(out.error).toContain('reviewTeams');
	});

	test('a PR whose details fail is reported in errors, not silently dropped by the filter', async () => {
		const out = await call(handler(['example-org/reviewers'], { failing: [2] }), 'list_prs', { review_team_requested: true });
		expect(numbers(out.pullRequests)).toEqual([1]);
		expect(out.errors).toEqual(['https://github.com/example-org/app/pull/2: details unavailable: proxy timeout']);
	});

	test('an idle PR that requests a review team still counts; other idle PRs stay out', async () => {
		const h = handler(['example-org/reviewers'], { extra: idleLights });
		expect(numbers((await call(h, 'list_prs', { review_team_requested: true })).pullRequests)).toEqual([1, 2, 6]);
		// The plain list keeps its old rules: the team's PRs only, idle ones left out.
		expect(numbers((await call(h, 'list_prs')).pullRequests)).toEqual([1, 3]);
		const queue = await call(h, 'review_queue', { person: 'bob' });
		expect(numbers(queue.pullRequests)).toEqual([1, 2, 6]);
		expect(queue.pullRequests.every((p: { waitingBecause: string[] }) => p.waitingBecause.join() === 'team')).toBe(true);
	});
});

describe('getDetail marks review teams', () => {
	const now = new Date().toISOString();
	const team = (combinedSlug: string) => ({
		requestedReviewer: { __typename: 'Team', slug: combinedSlug.split('/')[1], combinedSlug, name: combinedSlug },
	});
	// The smallest DETAIL_QUERY answer shapeDetail reads; GitHub returns combinedSlug in the org's own case.
	const detailData = (number: number) => ({
		repository: {
			defaultBranchRef: { name: 'main', target: { oid: 'base0' } },
			stackedOnThis: { nodes: [] },
			pullRequest: {
				number, title: 'PR', url: `https://github.com/example-org/app/pull/${number}`, state: 'OPEN', merged: false, mergedAt: null,
				isDraft: false, updatedAt: now, createdAt: now, headRefName: 'feature', baseRefName: 'main', headRefOid: 'head0',
				baseRefOid: 'base0', baseRef: { target: { oid: 'base0' } }, body: null, mergeable: 'MERGEABLE', reviewDecision: null,
				additions: 1, deletions: 0, changedFiles: 1, author: { login: 'outsider' }, statusCheckRollup: null,
				reviewRequests: { nodes: [team('Example-Org/reviewers'), team('other-org/reviewers')] },
				latestOpinionatedReviews: { nodes: [] }, participants: { totalCount: 0, nodes: [] }, comments: { nodes: [] },
				reviews: { nodes: [] }, commits: { nodes: [] }, reviewThreads: { nodes: [] },
			},
		},
	});

	function service() {
		const gh: GhRunner = {
			rate: {},
			get: () => Promise.reject(new Error('no compare in this test')),
			query: async <T>(_host: string, _q: string, vars?: Record<string, unknown>) => detailData(Number(vars?.n)) as T,
		};
		const config: Config = {
			me: 'alice',
			team: [alice, bob],
			hosts: {
				github: { hostname: 'github.com', label: 'GitHub', bot: null, reviewTeams: ['example-org/Reviewers'] },
				work: { hostname: 'github.example.com', label: 'Work', bot: null },
			},
			repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
		};
		return createPrService(config, gh);
	}

	test('matches the full org/team name in any case, and not the same slug in another org', async () => {
		const d = await service().getDetail({ host: 'github', owner: 'example-org', repo: 'app', number: 1, head: 'feature', base: 'main' });
		expect(d.requested.teams.map((t) => [t.combinedSlug, t.reviewTeam])).toEqual([
			['Example-Org/reviewers', true],
			['other-org/reviewers', false],
		]);
	});

	test('marks nothing on a host without reviewTeams', async () => {
		const d = await service().getDetail({ host: 'work', owner: 'example-org', repo: 'app', number: 2, head: 'feature', base: 'main' });
		expect(d.requested.teams.map((t) => t.reviewTeam)).toEqual([false, false]);
	});
});
