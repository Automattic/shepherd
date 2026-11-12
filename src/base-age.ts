// How old a PR's base is, in hours. Shared by the dashboard and the MCP tools so they agree.

import type { BaseAge } from './types.ts';

/** Hours since the merge base was committed, or null when unknown. */
export function baseAgeHours(b: BaseAge | null, now = Date.now()): number | null {
	if (!b?.mergeBaseAt) return null;
	const t = Date.parse(b.mergeBaseAt);
	return Number.isNaN(t) ? null : Math.max(0, (now - t) / 3_600_000);
}

/** True or false against the repo limit; null when there is no limit or the age is unknown. */
export function baseTooOld(b: BaseAge | null, now = Date.now()): boolean | null {
	const h = baseAgeHours(b, now);
	return b?.limitHours == null || h === null ? null : h > b.limitHours;
}
