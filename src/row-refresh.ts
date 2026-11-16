// How old a row may get before the page loads it again. Shared by the browser client and its tests.

/** The shortest allowed `rowRefreshFloorMs` and `rowRefreshLowBudgetMs`: the page must not load a row more often than every 10 seconds. */
export const MIN_ROW_REFRESH_MS = 10_000;

/** A value from /api/config: a number of milliseconds, raised to the minimum. Other values give `undefined`. */
function readMs(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? Math.max(v, MIN_ROW_REFRESH_MS) : undefined;
}

export interface RowAgeInput {
	/** `rowRefreshFloorMs` of the host, as /api/config sent it. */
	floorMs: unknown;
	/** `rowRefreshLowBudgetMs` of the host, as /api/config sent it. */
	lowBudgetMs: unknown;
	/** True for a host with a GraphQL budget (github.com): its default floor is slower. */
	metered: boolean;
	/** True when the host has less than 500 points of its budget left. */
	lowBudget: boolean;
	/** The refresh interval that the user picked. */
	intervalMs: number;
}

/**
 * The age in milliseconds after which the page loads a row again. The client checks the server's
 * values again, so a bad value (a string, 0, a negative number) cannot stop the refresh or load a
 * row on every tick. A low budget never makes a row load sooner than the floor or the user's interval.
 */
export function rowMaxAge({ floorMs, lowBudgetMs, metered, lowBudget, intervalMs }: RowAgeInput): number {
	const floor = readMs(floorMs) ?? (metered ? 120_000 : 20_000);
	return Math.max(intervalMs, floor, lowBudget ? (readMs(lowBudgetMs) ?? 600_000) : 0);
}
