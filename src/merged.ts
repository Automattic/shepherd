// Merged PRs over a few fixed ranges. Shared by the dashboard and the MCP tools so they agree.
// Ranges are in local time: the browser's for the dashboard, the server's for MCP.

import type { MergedPr } from './types.ts';

export const MERGED_RANGES = ['this-week', 'last-week', 'last-30-days'] as const;
export type MergedRange = (typeof MERGED_RANGES)[number];

export const MERGED_RANGE_LABELS: Record<MergedRange, string> = {
	'this-week': 'This week',
	'last-week': 'Last week',
	'last-30-days': 'Last 30 days',
};

export const isMergedRange = (v: unknown): v is MergedRange => (MERGED_RANGES as readonly unknown[]).includes(v);

/** The server fetches this many days back once, so every range can be filtered without a new request. */
const MERGED_FETCH_DAYS = 32; // 30 days, plus margin for time zones

/** Midnight at the start of the Monday of `now`'s week, in local time. */
export function weekStart(now: Date): Date {
	// Sunday is 0, so it belongs to the week that began six days earlier. Building the date from its parts,
	// not by stepping a Date, keeps a DST jump at midnight on another day from moving it to 01:00.
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
}

/** The range as [start, end): end is null for ranges that run up to now. */
export function rangeBounds(range: MergedRange, now: Date): { start: Date; end: Date | null } {
	if (range === 'last-30-days') return { start: new Date(now.getTime() - 30 * 86_400_000), end: null };
	const monday = weekStart(now);
	if (range === 'this-week') return { start: monday, end: null };
	return { start: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 7), end: monday };
}

/**
 * PRs merged in the range and written by one of `logins` (any case), newest first.
 * Closed-but-not-merged PRs have no mergedAt and are dropped.
 */
export function mergedInRange(prs: MergedPr[], logins: Iterable<string>, range: MergedRange, now: Date): MergedPr[] {
	const people = new Set([...logins].map((l) => l.toLowerCase()));
	const { start, end } = rangeBounds(range, now);
	return prs
		.filter((p) => {
			if (!p.mergedAt || !people.has(p.author.toLowerCase())) return false;
			const t = Date.parse(p.mergedAt);
			return t >= start.getTime() && (end === null || t < end.getTime());
		})
		.sort((a, b) => Date.parse(b.mergedAt!) - Date.parse(a.mergedAt!));
}

/** How many PRs each person merged, most first. */
export function countByAuthor(prs: MergedPr[], name: (login: string) => string): [string, number][] {
	const counts = new Map<string, number>();
	for (const p of prs) counts.set(name(p.author), (counts.get(name(p.author)) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** The UTC date (YYYY-MM-DD) for the server's `merged:>=` search qualifier. */
export function mergedSearchSince(now: Date): string {
	return new Date(now.getTime() - MERGED_FETCH_DAYS * 86_400_000).toISOString().slice(0, 10);
}
