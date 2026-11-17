// What keeps an approved PR from going out. The dashboard uses it for the "Ready to ship" and "Approved but blocked" bands.

import type { PrDetail } from './types.ts';

/**
 * Something stands between this PR and merging: merge conflicts, failed checks (pending checks don't count), an AI
 * review that is older than the newest commit (a new review may be on its way), or an unresolved "fix" thread of the
 * AI-review bot. A bot that has not reviewed the PR at all does not block: not every repo has the bot.
 */
export function hasBlockers(d: PrDetail): boolean {
	const checks = (d.checks ?? '').toUpperCase();
	return d.mergeable === 'CONFLICTING' || checks === 'FAILURE' || checks === 'ERROR' || d.bot?.current === false || (d.bot?.blocking ?? 0) > 0;
}
