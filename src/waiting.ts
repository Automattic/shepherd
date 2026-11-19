// What "waiting on someone" means. Shared by the dashboard and the MCP tools so they agree.
//
// A PR is waiting on a team member when any of these is true:
//   - requested: GitHub lists them as a pending reviewer (a direct request, not via a team).
//   - team:      the PR requests a review from one of the host's `reviewTeams`, which every team member
//                with a login on that host counts as belonging to. Not for its author, not on drafts,
//                not when they were also asked directly, and not once they approved. Not while they posted
//                (comment, review or push) after the author's last activity: it comes back when the author answers.
//   - turn:      someone else acted last (comment, review or push) on a PR they wrote. Taking part in
//                someone else's PR doesn't count unless they're assigned to it (see reply).
//   - author:    they wrote it, someone requested changes, and nothing was pushed since.
//   - reply:     they're assigned to someone else's PR (in its Assignees, or asked directly for a review that
//                they have since given), and the author commented, reviewed or pushed after their last post.
//                Not once their approval stands, and not once the review request was removed.

import type { PrDetail, TeamMember } from './types.ts';

export const WAIT_REASONS = ['requested', 'team', 'turn', 'author', 'reply'] as const;
export type WaitReason = (typeof WAIT_REASONS)[number];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const owns = (m: TeamMember, login: string) => Object.values(m.logins).some((l) => same(l, login));

/** Someone requested changes and the author hasn't pushed since the latest such review. */
export function changesRequestedPending(d: PrDetail): boolean {
	const requested = d.reviews
		.filter((r) => r.state === 'CHANGES_REQUESTED' && r.submittedAt)
		.map((r) => r.submittedAt as string)
		.sort();
	const latest = requested.at(-1);
	if (!latest) return false;
	return !d.lastCommitAt || d.lastCommitAt < latest;
}

/** This member's latest opinionated review is an approval. A dismissed approval shows as DISMISSED. */
export function hasStandingApproval(d: PrDetail, m: TeamMember): boolean {
	return d.reviews.some((r) => r.state === 'APPROVED' && owns(m, r.login));
}

/**
 * Someone else had the last word on a PR this member wrote. Taking part in someone else's PR doesn't count: it
 * waits on a non-author only through a direct or review-team request, or an assignment (see `awaitsReply`), so
 * stepping off as a reviewer takes it off their list.
 */
export function isTurnOf(d: PrDetail, m: TeamMember): boolean {
	const last = d.lastActivity;
	if (!last || owns(m, last.login)) return false;
	return owns(m, d.author.login);
}

/**
 * The author answered on a PR this member is assigned to: they're in its Assignees, or were asked directly for a
 * review (which GitHub clears once they review; removing the request takes them off). The author acted after this
 * member's last comment, review or push, or this member never posted. A standing approval ends it.
 */
export function awaitsReply(d: PrDetail, m: TeamMember): boolean {
	if (d.isDraft || owns(m, d.author.login) || hasStandingApproval(d, m)) return false;
	const assigned = [...(d.assignees ?? []), ...(d.assignedReviewers ?? [])].some((l) => owns(m, l));
	return assigned && Boolean(d.authorLastActive) && !postedSinceAuthor(d, m);
}

/**
 * This member commented, reviewed or pushed after the author's last activity, so the next move is the author's.
 * False when the author's activity is unknown (a ghost author, or commits not linked to their account): unknown
 * activity must not take a request away for good. Times are compared as instants, not as strings.
 */
export function postedSinceAuthor(d: PrDetail, m: TeamMember): boolean {
	if (!d.authorLastActive) return false;
	const author = Date.parse(d.authorLastActive);
	const mine = Math.max(...d.participants.filter((p) => owns(m, p.login) && p.lastActive).map((p) => Date.parse(p.lastActive as string)));
	return Number.isFinite(mine) && Number.isFinite(author) && mine >= author;
}

/** Why an open PR is waiting on this member; empty when it isn't. */
export function waitReasons(d: PrDetail, m: TeamMember): WaitReason[] {
	if (d.state !== 'OPEN') return [];
	const reasons: WaitReason[] = [];
	if (d.requested.users.some((u) => owns(m, u.login))) reasons.push('requested');
	else if (
		d.requested.teams.some((t) => t.reviewTeam) &&
		!d.isDraft &&
		m.logins[d.host] &&
		!owns(m, d.author.login) &&
		!hasStandingApproval(d, m) &&
		!postedSinceAuthor(d, m)
	) {
		reasons.push('team');
	}
	if (owns(m, d.author.login) && changesRequestedPending(d)) reasons.push('author');
	if (isTurnOf(d, m)) reasons.push('turn');
	if (!reasons.includes('requested') && awaitsReply(d, m)) reasons.push('reply');
	return reasons;
}

export const WAIT_REASON_TEXT: Record<WaitReason, string> = {
	requested: 'review requested',
	team: "your team's review requested",
	turn: 'someone else had the last word',
	author: 'changes requested, nothing pushed since',
	reply: 'the author replied since your last post',
};
