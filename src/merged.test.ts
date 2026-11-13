import { describe, expect, test } from 'bun:test';
import { countByAuthor, mergedInRange, mergedSearchSince, rangeBounds, weekStart } from './merged.ts';
import type { MergedPr } from './types.ts';

// Dates are built in local time, as the dashboard sees them. 2026-11-16 is a Monday.
const local = (d: number, h = 0, m = 0, s = 0, ms = 0) => new Date(2026, 10, d, h, m, s, ms);

let n = 0;
function pr(mergedAt: Date | null, author = 'alice'): MergedPr {
	n++;
	return {
		key: `github:example-org/app#${n}`,
		host: 'github',
		owner: 'example-org',
		repo: 'app',
		number: n,
		title: `PR ${n}`,
		url: `https://github.com/example-org/app/pull/${n}`,
		author,
		mergedAt: mergedAt ? mergedAt.toISOString() : null,
	};
}

const team = ['alice', 'bob'];
const numbers = (list: MergedPr[]) => list.map((p) => p.number);

describe('weekStart', () => {
	test('a Sunday belongs to the week that began the Monday before', () => {
		expect(weekStart(local(15, 23, 59))).toEqual(local(9));
	});
	test('Monday at midnight starts a new week', () => {
		expect(weekStart(local(16))).toEqual(local(16));
	});
});

describe('this-week', () => {
	const now = local(18, 12); // Wednesday
	test('Sunday 23:59 is out, Monday 00:00 is in', () => {
		const sunday = pr(local(15, 23, 59, 59, 999));
		const monday = pr(local(16));
		expect(numbers(mergedInRange([sunday, monday], team, 'this-week', now))).toEqual([monday.number]);
	});
});

describe('last-week', () => {
	const now = local(18, 12);
	test('runs from the previous Monday 00:00 through Sunday 23:59', () => {
		const beforeStart = pr(local(8, 23, 59, 59, 999));
		const start = pr(local(9));
		const lastMinute = pr(local(15, 23, 59, 59, 999));
		const thisWeek = pr(local(16));
		const got = mergedInRange([beforeStart, start, lastMinute, thisWeek], team, 'last-week', now);
		expect(numbers(got)).toEqual([lastMinute.number, start.number]);
	});
	test('the bounds are exactly two Mondays', () => {
		expect(rangeBounds('last-week', now)).toEqual({ start: local(9), end: local(16) });
	});
});

describe('last-30-days', () => {
	const now = local(18, 12);
	test('exactly 30 days ago is in, a millisecond earlier is out', () => {
		const start = new Date(now.getTime() - 30 * 86_400_000);
		const edge = pr(start);
		const before = pr(new Date(start.getTime() - 1));
		expect(numbers(mergedInRange([before, edge], team, 'last-30-days', now))).toEqual([edge.number]);
	});
	test('the server search date covers the whole range in any time zone', () => {
		const since = Date.parse(`${mergedSearchSince(now)}T00:00:00Z`);
		expect(since).toBeLessThan(rangeBounds('last-30-days', now).start.getTime() - 14 * 3_600_000);
		expect(since).toBeLessThan(rangeBounds('last-week', now).start.getTime() - 14 * 3_600_000);
	});
});

describe('mergedInRange', () => {
	const now = local(18, 12);
	test('leaves out PRs by people outside the list', () => {
		const ours = pr(local(17), 'alice');
		const theirs = pr(local(17), 'mallory');
		expect(numbers(mergedInRange([ours, theirs], team, 'this-week', now))).toEqual([ours.number]);
	});
	test('leaves out PRs that were closed without merging', () => {
		const closed = pr(null);
		const mergedPr = pr(local(17));
		expect(numbers(mergedInRange([closed, mergedPr], team, 'this-week', now))).toEqual([mergedPr.number]);
	});
	test('matches logins in any case and sorts newest first', () => {
		const older = pr(local(16, 9), 'Alice');
		const newer = pr(local(17, 9), 'BOB');
		expect(numbers(mergedInRange([older, newer], team, 'this-week', now))).toEqual([newer.number, older.number]);
	});
});

test('countByAuthor counts per person, most first', () => {
	const list = [pr(local(16), 'bob'), pr(local(16), 'alice'), pr(local(17), 'bob')];
	expect(countByAuthor(list, (l) => l.toUpperCase())).toEqual([['BOB', 2], ['ALICE', 1]]);
});

describe('daylight saving time', () => {
	const saved = process.env.TZ;
	test('a midnight clock change does not move Monday to 01:00', () => {
		// In Santiago, 2026-09-06 00:00 does not exist: clocks jump to 01:00.
		process.env.TZ = 'America/Santiago';
		try {
			const sunday = new Date(2026, 8, 6, 12);
			expect(weekStart(sunday).getHours()).toBe(0);
			expect(weekStart(sunday).getDate()).toBe(31);
			const { start, end } = rangeBounds('last-week', new Date(2026, 8, 9, 12));
			expect([start.getDate(), start.getHours(), end!.getDate(), end!.getHours()]).toEqual([31, 0, 7, 0]);
		} finally {
			process.env.TZ = saved;
		}
	});
});
