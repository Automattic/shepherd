// The activity-based "waiting on" rules: "turn" (author only), the last-word gate on review-team requests, and
// "reply" for assigned PRs. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import type { PrDetail, TeamMember } from './types.ts';
import { isTurnOf, waitReasons } from './waiting.ts';

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
		updatedAt: '2026-01-03T00:00:00Z',
		createdAt: '2026-01-01T00:00:00Z',
		headRefName: 'add-thing',
		baseRefName: 'main',
		fork: null,
		author: { login: 'alice', name: 'Alice' },
		mergeable: 'MERGEABLE',
		reviewDecision: 'REVIEW_REQUIRED',
		checks: null,
		size: { additions: 1, deletions: 0, files: 1 },
		requested: { users: [], teams: [] },
		reviews: [],
		bot: null,
		// Bob committed and commented on Alice's PR; Carol (outside the team) reviewed it last.
		participants: [
			{ login: 'carol', name: 'Carol', lastActive: '2026-01-03T00:00:00Z' },
			{ login: 'bob', name: 'Bob', lastActive: '2026-01-02T00:00:00Z' },
		],
		authorLastActive: '2026-01-01T00:00:00Z',
		lastActivity: { login: 'carol', at: '2026-01-03T00:00:00Z', kind: 'review' },
		lastCommitAt: '2026-01-02T00:00:00Z',
		linear: [],
		refs: [],
		hashRefs: [],
		parent: null,
		stackedOnThis: [],
		baseAge: null,
		fetchedAt: '2026-01-03T00:00:00Z',
		...over,
	};
}

describe('the turn rule', () => {
	test('someone else having the last word on your own PR waits on you', () => {
		expect(isTurnOf(pr(), alice)).toBe(true);
		expect(waitReasons(pr(), alice)).toEqual(['turn']);
	});

	test('taking part in a PR you were not asked to review does not make it wait on you', () => {
		expect(isTurnOf(pr(), bob)).toBe(false);
		expect(waitReasons(pr(), bob)).toEqual([]);
	});

	test('a participant still waits when their review is requested', () => {
		const requested = { users: [{ login: 'bob', name: 'Bob' }], teams: [] };
		expect(waitReasons(pr({ requested }), bob)).toEqual(['requested']);
	});

	test('a participant still waits when their review team is requested and the author answered them', () => {
		const requested = { users: [], teams: [{ slug: 'reviewers', combinedSlug: 'example-org/reviewers', name: 'Reviewers', reviewTeam: true }] };
		expect(waitReasons(pr({ requested, authorLastActive: '2026-01-04T00:00:00Z' }), bob)).toEqual(['team']);
	});

	test('the author having the last word is nobody\'s turn', () => {
		const lastActivity = { login: 'alice', at: '2026-01-04T00:00:00Z', kind: 'commit' as const };
		expect(waitReasons(pr({ lastActivity }), alice)).toEqual([]);
		expect(waitReasons(pr({ lastActivity }), bob)).toEqual([]);
	});
});

describe('a review-team request and the last word', () => {
	const team = { users: [], teams: [{ slug: 'reviewers', combinedSlug: 'example-org/reviewers', name: 'Reviewers', reviewTeam: true }] };

	test('a member who posted after the author is off the hook until the author answers', () => {
		// Bob last posted on 2026-01-02; Alice (the author) was last active on 2026-01-01.
		expect(waitReasons(pr({ requested: team }), bob)).toEqual([]);
		expect(waitReasons(pr({ requested: team, authorLastActive: '2026-01-04T00:00:00Z' }), bob)).toEqual(['team']);
	});

	test('a member who never posted still waits', () => {
		expect(waitReasons(pr({ requested: team, participants: [] }), bob)).toEqual(['team']);
	});

	test("unknown author activity (a ghost author, or unlinked commits) doesn't take the request away", () => {
		expect(waitReasons(pr({ requested: team, authorLastActive: null }), bob)).toEqual(['team']);
	});

	test('a tie means the member posted last', () => {
		expect(waitReasons(pr({ requested: team, authorLastActive: '2026-01-02T00:00:00Z' }), bob)).toEqual([]);
	});

	test('times are compared as instants, not as strings', () => {
		// 2026-01-02T08:00:00+09:00 is 2026-01-01T23:00Z, before Bob's post; as a string it sorts after it.
		expect(waitReasons(pr({ requested: team, authorLastActive: '2026-01-02T08:00:00+09:00' }), bob)).toEqual([]);
	});
});

describe('the reply rule', () => {
	// Bob last posted on 2026-01-02. The author answers after that unless a test says otherwise.
	const answered = { authorLastActive: '2026-01-04T00:00:00Z', lastActivity: { login: 'alice', at: '2026-01-04T00:00:00Z', kind: 'commit' as const } };

	test('an assignee waits once the author answers after their last post', () => {
		expect(waitReasons(pr({ ...answered, assignees: ['bob'] }), bob)).toEqual(['reply']);
	});

	test('a reviewer whose request cleared when they reviewed waits once the author answers', () => {
		expect(waitReasons(pr({ ...answered, assignedReviewers: ['bob'] }), bob)).toEqual(['reply']);
	});

	test('nothing waits on them while they have the last word over the author', () => {
		expect(waitReasons(pr({ assignees: ['bob'], authorLastActive: '2026-01-01T00:00:00Z' }), bob)).toEqual([]);
	});

	test('another participant answering is not the author answering', () => {
		// Carol acted last, but Alice (the author) was last active before Bob's post.
		expect(waitReasons(pr({ assignedReviewers: ['bob'], authorLastActive: '2026-01-01T00:00:00Z' }), bob)).toEqual([]);
	});

	test('an assignee who never posted waits on any author activity', () => {
		expect(waitReasons(pr({ ...answered, assignees: ['bob'], participants: [] }), bob)).toEqual(['reply']);
	});

	test('taking part without an assignment keeps it off their list', () => {
		// The shaping leaves a login whose request was removed out of assignedReviewers (see the contract case
		// reviews-and-requests), so such a person is only a participant, as Bob is here.
		expect(waitReasons(pr({ ...answered }), bob)).toEqual([]);
	});

	test('unknown author activity never fires it', () => {
		expect(waitReasons(pr({ assignees: ['bob'], authorLastActive: null }), bob)).toEqual([]);
	});

	test('drafts are left out', () => {
		expect(waitReasons(pr({ ...answered, assignees: ['bob'], isDraft: true }), bob)).toEqual([]);
	});

	test('a standing approval ends it; a dismissed one brings it back', () => {
		const approved = [{ login: 'bob', state: 'APPROVED' as const, submittedAt: '2026-01-02T00:00:00Z' }];
		const dismissed = [{ login: 'bob', state: 'DISMISSED' as const, submittedAt: '2026-01-02T00:00:00Z' }];
		expect(waitReasons(pr({ ...answered, assignees: ['bob'], reviews: approved }), bob)).toEqual([]);
		expect(waitReasons(pr({ ...answered, assignees: ['bob'], reviews: dismissed }), bob)).toEqual(['reply']);
	});

	test('a pending request gives "requested" alone', () => {
		const requested = { users: [{ login: 'bob', name: 'Bob' }], teams: [] };
		expect(waitReasons(pr({ ...answered, assignedReviewers: ['bob'], requested }), bob)).toEqual(['requested']);
	});

	test('the author is never waiting on their own reply', () => {
		expect(waitReasons(pr({ ...answered, assignees: ['alice'] }), alice)).toEqual([]);
	});
});
