// What "waiting on someone" means. Shared by the dashboard and the MCP tools so they agree.
//
// A PR is waiting on a team member when any of these is true:
//   - requested: GitHub lists them as a pending reviewer (a direct request, not via a team).
//   - turn:      someone else acted last (comment, review or push) on a PR they wrote or took part in.
//   - author:    they wrote it, someone requested changes, and nothing was pushed since.

import type { PrDetail, TeamMember } from './types.ts';

export type WaitReason = 'requested' | 'turn' | 'author';

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

/** Someone else had the last word on a PR this member wrote or took part in. */
export function isTurnOf(d: PrDetail, m: TeamMember): boolean {
	const last = d.lastActivity;
	if (!last || owns(m, last.login)) return false;
	return owns(m, d.author.login) || d.participants.some((p) => owns(m, p.login));
}

/** Why an open PR is waiting on this member; empty when it isn't. */
export function waitReasons(d: PrDetail, m: TeamMember): WaitReason[] {
	if (d.state !== 'OPEN') return [];
	const reasons: WaitReason[] = [];
	if (d.requested.users.some((u) => owns(m, u.login))) reasons.push('requested');
	if (owns(m, d.author.login) && changesRequestedPending(d)) reasons.push('author');
	if (isTurnOf(d, m)) reasons.push('turn');
	return reasons;
}

export const WAIT_REASON_TEXT: Record<WaitReason, string> = {
	requested: 'review requested',
	turn: 'someone else had the last word',
	author: 'changes requested, nothing pushed since',
};
