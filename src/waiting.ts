// What "waiting on someone" means. Shared by the dashboard and the MCP tools so they agree.
//
// A PR is waiting on a team member when any of these is true:
//   - requested: GitHub lists them as a pending reviewer (a direct request, not via a team).
//   - team:      the PR requests a review from one of the host's `reviewTeams`, which every team member
//                with a login on that host counts as belonging to. Not for its author, not on drafts,
//                not when they were also asked directly, and not once they approved.
//   - turn:      someone else acted last (comment, review or push) on a PR they wrote or took part in,
//                unless they already approved it and that approval still stands (not dismissed).
//   - author:    they wrote it, someone requested changes, and nothing was pushed since.

import type { PrDetail, TeamMember } from './types.ts';

export type WaitReason = 'requested' | 'team' | 'turn' | 'author';

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

/** Someone else had the last word on a PR this member wrote or took part in, and they haven't already approved it. */
export function isTurnOf(d: PrDetail, m: TeamMember): boolean {
	const last = d.lastActivity;
	if (!last || owns(m, last.login)) return false;
	if (hasStandingApproval(d, m)) return false;
	return owns(m, d.author.login) || d.participants.some((p) => owns(m, p.login));
}

/** Why an open PR is waiting on this member; empty when it isn't. */
export function waitReasons(d: PrDetail, m: TeamMember): WaitReason[] {
	if (d.state !== 'OPEN') return [];
	const reasons: WaitReason[] = [];
	if (d.requested.users.some((u) => owns(m, u.login))) reasons.push('requested');
	else if (d.requested.teams.some((t) => t.reviewTeam) && !d.isDraft && m.logins[d.host] && !owns(m, d.author.login) && !hasStandingApproval(d, m)) {
		reasons.push('team');
	}
	if (owns(m, d.author.login) && changesRequestedPending(d)) reasons.push('author');
	if (isTurnOf(d, m)) reasons.push('turn');
	return reasons;
}

export const WAIT_REASON_TEXT: Record<WaitReason, string> = {
	requested: 'review requested',
	team: "your team's review requested",
	turn: 'someone else had the last word',
	author: 'changes requested, nothing pushed since',
};
