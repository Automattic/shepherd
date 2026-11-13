// What "ready for review by agents" means. Computed on the server for each PR detail, so the
// dashboard and the MCP tools agree.
//
// An open PR is ready when:
//   - it is not a draft (unless `readyForReview` is false),
//   - it has none of the `skipLabels`, and
//   - with `match: "any"` (the default), at least one listed reviewer, team or label is present;
//     with `match: "all"`, every listed one is. A config that lists none of them only applies the
//     two checks above.
//
// Requested reviewers and teams count only while the request is pending: GitHub drops a request
// once that reviewer submits a review, so a PR stops being ready after the agent has reviewed it,
// until someone requests it again.

import type { AgentReadiness, AgentReviewConfig, Config, PrDetail, TeamMember } from './types.ts';

const lower = (s: string) => s.trim().toLowerCase();

/** The rule for one repo: its own `agentReview` when set (null turns it off), else the top-level one. */
export function agentReviewFor(config: Pick<Config, 'agentReview' | 'repos'>, host: string, owner: string, repo: string): AgentReviewConfig | null {
	const r = config.repos.find((x) => x.host === host && lower(x.owner) === lower(owner) && lower(x.name) === lower(repo));
	if (r && r.agentReview !== undefined) return r.agentReview;
	return config.agentReview ?? null;
}

/**
 * A reviewer entry is a team member id (resolved to their login on this host) or a raw login.
 * Null when it names a member with no login on this host: that reviewer can't be requested here,
 * so it is no signal at all (and doesn't block `match: "all"` forever).
 */
function reviewerLogin(entry: string, host: string, team: TeamMember[]): string | null {
	const m = team.find((t) => t.id === entry);
	return m ? (m.logins[host] ?? null) : entry;
}

/** "org/slug" and "slug" both name the team; team slugs are unique within the PR's org. */
const teamSlug = (entry: string) => lower(entry.includes('/') ? entry.slice(entry.indexOf('/') + 1) : entry);

type PrFacts = Pick<PrDetail, 'host' | 'state' | 'isDraft' | 'labels' | 'requested'>;

export function agentReadiness(d: PrFacts, rule: AgentReviewConfig, team: TeamMember[]): AgentReadiness {
	const blocked: string[] = [];
	if (d.state !== 'OPEN') blocked.push(d.state === 'MERGED' ? 'merged' : 'closed');
	if (rule.readyForReview !== false && d.isDraft) blocked.push('draft');

	const labels = new Set(d.labels.map(lower));
	for (const l of rule.skipLabels ?? []) if (labels.has(lower(l))) blocked.push(`label "${l}"`);

	const requestedLogins = new Set([...d.requested.users, ...d.requested.bots].map((u) => lower(u.login)));
	const requestedTeams = new Set(d.requested.teams.map((t) => lower(t.slug)));

	const signals: { text: string; present: boolean }[] = [
		...(rule.reviewers ?? []).flatMap((r) => {
			const login = reviewerLogin(r, d.host, team);
			return login ? [{ text: `review requested from ${login}`, present: requestedLogins.has(lower(login)) }] : [];
		}),
		...(rule.teams ?? []).map((t) => ({ text: `review requested from team ${t}`, present: requestedTeams.has(teamSlug(t)) })),
		...(rule.labels ?? []).map((l) => ({ text: `label "${l}"`, present: labels.has(lower(l)) })),
	];
	const matched = signals.filter((s) => s.present).map((s) => s.text);
	if (signals.length) {
		if (rule.match === 'all') {
			for (const s of signals) if (!s.present) blocked.push(`no ${s.text}`);
		} else if (!matched.length) {
			blocked.push('no listed reviewer, team or label');
		}
	}
	if (!signals.length && rule.readyForReview !== false && !blocked.length) matched.push('ready for review');

	return { ready: blocked.length === 0, matched, blocked };
}

const RULE_KEYS = new Set(['readyForReview', 'reviewers', 'teams', 'labels', 'match', 'skipLabels']);

/** Problems with an `agentReview` value, for the startup config check. */
export function agentReviewProblems(where: string, v: unknown): string[] {
	if (v === undefined || v === null) return [];
	if (typeof v !== 'object' || Array.isArray(v)) return [`${where} must be an object, or null`];
	const out: string[] = [];
	const rule = v as Record<string, unknown>;
	for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k)) out.push(`${where} has unknown key "${k}" (known: ${[...RULE_KEYS].join(', ')})`);
	for (const k of ['reviewers', 'teams', 'labels', 'skipLabels']) {
		const list = rule[k];
		if (list !== undefined && !(Array.isArray(list) && list.every((x) => typeof x === 'string' && x.trim()))) {
			out.push(`${where}.${k} must be an array of non-empty strings`);
		}
	}
	// Logins can't contain "/", so "org/slug" here is a team in the wrong list; it would never match.
	for (const r of Array.isArray(rule.reviewers) ? rule.reviewers : []) {
		if (typeof r === 'string' && r.includes('/')) out.push(`${where}.reviewers has "${r}", which is a team; move it to "teams"`);
	}
	if (rule.readyForReview !== undefined && typeof rule.readyForReview !== 'boolean') out.push(`${where}.readyForReview must be true or false`);
	if (rule.match !== undefined && rule.match !== 'any' && rule.match !== 'all') out.push(`${where}.match must be "any" or "all"`);
	const listsSomething = ['reviewers', 'teams', 'labels'].some((k) => Array.isArray(rule[k]) && (rule[k] as unknown[]).length);
	if (!listsSomething && rule.readyForReview === false) {
		out.push(`${where} would mark every open PR, drafts included, as ready; list reviewers, teams or labels, or drop readyForReview: false`);
	}
	return out;
}
