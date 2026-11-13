// Follow-ups: the non-blocking asks people leave on a PR ("Optional:", "in a follow-up", "Notes that do not block:").
// Pure text parsing, shared by the server and the tests. Fetching lives in src/prs.ts.

import type { FollowUp, FollowUpSource } from './types.ts';

/** One piece of text on a PR: its description, a review, a comment or an inline comment. */
export interface FollowUpText {
	author: string;
	source: FollowUpSource;
	body: string | null;
	url: string;
	path?: string | null;
	line?: number | null;
	at: string | null;
	/** The code changed after this was written; see FollowUp.stale. */
	stale?: boolean;
}

const words = (list: string[]) => new RegExp(list.map((p) => `\\b${p}\\b`).join('|'), 'i');

/** A line that names work for later, or says it does not block. "Follow-up to #12" points back, so it doesn't count. */
const LATER_WORK = words([
	'follow[- ]?ups?(?! (?:to|of|on)\\b)',
	// Not "a PR" or "new PR": "such a PR waits", "before opening a PR" and "a PR closed without merging" are prose.
	'(?:another|separate|next|later|future|subsequent) (?:pr|pull request)',
	'separate (?:change|issue|ticket)',
	'before the [\\w-]+(?: [\\w-]+)? (?:pr|pull request)',
	'needs? (?:a )?decision',
	"(?:do|does|did)(?: not|n't) block",
	"don'?t block",
]);


/** Upper case only: "the todo list" is a feature, "TODO: drop the flag" is a task. */
const TODO = /\bTODO\b/;

/**
 * Words that mark the list under a heading as non-blocking. They are too common in ordinary prose
 * ("makes the fetch non-blocking", "tested before merging") to count on a line of their own.
 */
const HEADING_WORDS = new RegExp(
	`${LATER_WORK.source}|${words(['optional', 'nice to have', 'for later', 'future work', 'nits?', 'non[- ]?blocking', 'not blocking', 'before (?:merg(?:e|ing)|landing|shipping)']).source}`,
	'i'
);

/**
 * What makes a longer lead-in line, of more than one sentence, introduce a non-blocking list:
 * "These items do not block this PR. Fix them before the wiring PR:". Narrower than HEADING_WORDS,
 * because "Tested before merging. Steps:" or "Split out in a separate PR. Changes:" introduce no asks.
 */
const LEAD_IN_WORDS = words(["(?:do|does|did)(?: not|n't) block", "don'?t block", 'non[- ]?blocking', 'not blocking', 'optional', 'nits?', 'for later']);

/** "Optional: rename this" on one line. */
const PREFIX = /^(?:optional|nice to have|non[- ]?blocking|not blocking|nit)\s*[:,-]/i;

/** What an empty template section says. */
const EMPTY_ITEM = /^(?:none|n\/a|nothing|tbd|-+)\.?$/i;

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*/;
const MAX_TEXT = 280;

/** Most PRs one /api/followups request may name. */
export const FOLLOWUPS_MAX_PRS = 100;

/** Drops what is not a sentence of the writer's own: HTML comments, code blocks, quoted text and table rows. */
function cleanLines(body: string): string[] {
	return body
		.replace(/\r/g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/^(\s*)(```|~~~)[\s\S]*?^\1\2[^\n]*$/gm, '')
		.split('\n')
		.filter((l) => !/^\s*[>|]/.test(l));
}

/** The words of a heading-like line, or null when the line is not one: `## Later`, `**Optional:**`, `Notes that do not block:`. */
function headingText(line: string): string | null {
	const t = line.trim();
	if (t.length > 120) return null;
	const bare = t
		.replace(/^#{1,6}\s+/, '')
		.replace(/^(\*\*|__)(.+)\1$/, '$2')
		.trim();
	// A plain line ending in ":" is a heading only when it is one short phrase, not "Follow-up to #12. This PR:".
	const isHeading = /^#{1,6}\s/.test(t) || /^(\*\*|__).+(\*\*|__):?$/.test(t) || (/:$/.test(t) && !/[.!?]\s/.test(t));
	return isHeading ? bare.replace(/[:*_\s]+$/, '') : null;
}

/** A line of more than one sentence that ends in ":" and says the list after it doesn't block. */
function isLeadIn(line: string): boolean {
	const t = line.trim();
	return t.length <= 300 && /:$/.test(t) && /[.!?]\s/.test(t) && LEAD_IN_WORDS.test(t);
}

/**
 * A line that counts on its own, outside a list under a heading. "Out of scope" is not in the list: it explains
 * why something isn't part of this work, so an "Out of scope" section or line asks nothing.
 */
function isFollowUpLine(text: string): boolean {
	return LATER_WORK.test(text) || TODO.test(text) || PREFIX.test(text);
}

function tidy(text: string): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/** The follow-ups in one piece of text, in order. */
export function followUpLines(body: string | null): string[] {
	if (!body) return [];
	const out: string[] = [];
	let underHeading = false;
	let last = -1; // index in `out` of the item that indented lines continue
	// A lead-in line with no list under it still counts on its own when its words do.
	let leadIn: { text: string; at: number } | null = null;
	const endLeadIn = () => {
		if (leadIn && out.length === leadIn.at && isFollowUpLine(leadIn.text)) out.push(leadIn.text);
		leadIn = null;
	};

	for (const raw of cleanLines(body)) {
		if (!raw.trim()) {
			last = -1;
			continue;
		}
		const item = LIST_ITEM.exec(raw);
		if (underHeading) {
			if (item) {
				const check = CHECKBOX.exec(item[1]!);
				if (check?.[1]?.toLowerCase() === 'x') last = -1; // done already
				else last = out.push(item[1]!.replace(CHECKBOX, '')) - 1;
				continue;
			}
			// A blank line resets `last`, so only an indented line right under an item continues it.
			if (last >= 0 && /^\s{2,}\S/.test(raw)) {
				out[last] += ` ${raw.trim()}`;
				continue;
			}
			// Any other line, such as the next paragraph, ends the list.
			underHeading = false;
			endLeadIn();
		}
		last = -1;

		const heading = headingText(raw);
		if (heading !== null && HEADING_WORDS.test(heading)) {
			underHeading = true;
			continue;
		}
		// Any other heading ("## Out of scope", "## TODO") names a section; it asks nothing on its own.
		if (heading !== null) continue;
		if (!item && isLeadIn(raw)) {
			underHeading = true;
			leadIn = { text: raw.trim(), at: out.length };
			continue;
		}
		const text = item ? item[1]!.replace(CHECKBOX, '') : raw.trim();
		if (isFollowUpLine(text)) out.push(text);
	}
	endLeadIn();
	return out.map(tidy).filter((t) => t.length > 1 && !EMPTY_ITEM.test(t));
}

/** The follow-ups that count: not the ones the code may have done since (`stale`). */
export function liveFollowUps<T extends { stale?: boolean }>(list: readonly T[] | undefined): T[] {
	return list ? list.filter((f) => !f.stale) : [];
}

/**
 * The PRs in `prs` with at least one live follow-up, in the same order. `loading` says some PRs have no answer
 * yet (neither follow-ups nor an error), so the count may still grow.
 */
export function needingFollowUp<T extends { key: string }>(
	prs: T[],
	followUps: ReadonlyMap<string, readonly { stale?: boolean }[]>,
	failed: ReadonlySet<string> = new Set()
): { prs: T[]; loading: boolean } {
	return {
		prs: prs.filter((p) => liveFollowUps(followUps.get(p.key)).length > 0),
		loading: prs.some((p) => !followUps.has(p.key) && !failed.has(p.key)),
	};
}

/**
 * Every follow-up on a PR, oldest first (the description is dated when the PR opened). The same line said twice
 * counts once; when it was said again after the code changed, the later copy stays live.
 */
export function extractFollowUps(texts: FollowUpText[]): FollowUp[] {
	const ordered = [...texts].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
	const seen = new Map<string, number>();
	const out: FollowUp[] = [];
	for (const t of ordered) {
		const stale = t.stale ?? false;
		for (const text of followUpLines(t.body)) {
			const key = text.toLowerCase();
			const at = seen.get(key);
			if (at !== undefined) {
				if (out[at]!.stale && !stale) out[at]!.stale = false;
				continue;
			}
			seen.set(key, out.push({ author: t.author, source: t.source, path: t.path ?? null, line: t.line ?? null, text, url: t.url, at: t.at, stale }) - 1);
		}
	}
	return out;
}
