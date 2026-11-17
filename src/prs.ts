// Pull request data: the light list search and the full per-PR detail, with caching.

import { extractFollowUps, type FollowUpText } from './followups.ts';
import type { GhRunner } from './gh.ts';
import { mergedSearchSince } from './merged.ts';
import { BATCH_MAX, buildDetailBatch, MERGED_SEARCH_QUERY, SEARCH_QUERY } from './queries.ts';
import { linearKeyRegExp } from './linear.ts';
import { allReviewBots, reviewBot } from './review-bot.ts';
import {
	SEVERITIES,
	type BaseAge,
	type BotFinding,
	type BotSummary,
	type Config,
	type FollowUp,
	type FollowUpsResponse,
	type LightPr,
	type LastActivity,
	type MergedPr,
	type MiniPr,
	type Participant,
	type PrDetail,
	type PrRef,
	type PrReview,
	type Severity,
	type TeamMember,
} from './types.ts';

const LIST_TTL_MS = 2_000;
// In "list" mode, every list call reuses a list this new, a failed search waits this long, and a detail call (also a forced one) reuses details this new, so no client calls GitHub more often.
const LIST_MODE_TTL_MS = 10_000;
const DETAIL_TTL_MS = 3_000;
const FORCED_DETAIL_TTL_MS = 1_000;
const LOW_BUDGET_LIST = 300; // below this, reuse the last list for up to 5 minutes
const MERGED_TTL_MS = 60_000; // merges are history; once a minute is plenty
const LOW_BUDGET_DETAIL = 150; // below this, serve cached details, and the list sends no detail batch
const DETAIL_HOLD_MS = 60_000; // the list leaves a PR alone this long after its detail batch failed
/** A PR idle for longer than this is dormant: the page hides it, and the list does not fetch its details unless a review is requested. */
export const DORMANT_MS = 60 * 24 * 3600 * 1000;
const BASE_AGE_TTL_MS = 10 * 60_000; // the merge base only moves with the head; this refreshes behindBy
const BASE_AGE_RETRY_MS = 60_000; // a failed compare call is retried after this
const BASE_AGE_CACHE_MAX = 1_000;
const FOLLOWUPS_TTL_MS = 10 * 60_000; // comments rarely change once a PR has merged
const FOLLOWUPS_BATCH = 10; // PRs per GraphQL query (one repo per query)
const FOLLOWUPS_CACHE_MAX = 1_000;

// ---------------------------------------------------------------------------
// Raw GraphQL shapes

interface RawAuthor {
	login: string;
	name?: string | null;
	/** `Bot` for a GitHub App or a bot account, whatever its login is. */
	__typename?: string;
}

interface RawLightPr {
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	updatedAt: string;
	createdAt: string;
	headRefName: string;
	baseRefName: string;
	isCrossRepository: boolean;
	headRepositoryOwner: { login: string } | null;
	author: RawAuthor | null;
	repository: { name: string; owner: { login: string } };
}

interface RawMergedPr {
	number: number;
	title: string;
	url: string;
	mergedAt: string | null;
	author: { login: string } | null;
	repository: { name: string; owner: { login: string } };
}

interface SearchData<T = RawLightPr> {
	search: {
		issueCount: number;
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
		nodes: (T | Record<string, never> | null)[];
	};
}

interface RawMiniPr {
	number: number;
	title: string;
	url: string;
	author: RawAuthor | null;
}

interface RawDetailPr {
	number: number;
	title: string;
	url: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	merged: boolean;
	mergedAt: string | null;
	isDraft: boolean;
	updatedAt: string;
	createdAt: string;
	headRefName: string;
	baseRefName: string;
	isCrossRepository: boolean;
	headRepositoryOwner: { login: string } | null;
	headRefOid: string;
	/** The base tip when the head last moved; `baseRef` has the current tip. */
	baseRefOid: string;
	baseRef: { target: { oid: string } | null } | null;
	body: string | null;
	mergeable: PrDetail['mergeable'];
	reviewDecision: PrDetail['reviewDecision'];
	additions: number;
	deletions: number;
	changedFiles: number;
	author: RawAuthor | null;
	statusCheckRollup: { state: string } | null;
	reviewRequests: {
		nodes: {
			requestedReviewer:
				| { __typename: 'User'; login: string; name: string | null }
				| { __typename: 'Team'; slug: string; combinedSlug: string; name: string }
				| { __typename: string }
				| null;
		}[];
	};
	latestOpinionatedReviews: { nodes: { state: PrReview['state']; submittedAt: string | null; author: RawAuthor | null }[] };
	participants: { totalCount: number; nodes: { login: string; name: string | null }[] };
	comments: { nodes: { author: RawAuthor | null; createdAt: string }[] };
	reviews: { nodes: { author: RawAuthor | null; submittedAt: string | null }[] };
	commits: { nodes: { commit: { committedDate: string; author: { user: { login: string } | null } | null } }[] };
	reviewThreads: {
		nodes: {
			isResolved: boolean;
			isOutdated: boolean;
			path: string | null;
			line: number | null;
			comments: { nodes: { author: RawAuthor | null; body: string; url: string; createdAt: string }[] };
		}[];
	};
}

interface DetailData {
	repository: {
		defaultBranchRef: { name: string; target: { oid: string } | null } | null;
		pullRequest: RawDetailPr | null;
		parent?: { nodes: RawMiniPr[] };
		stackedOnThis: { nodes: RawMiniPr[] };
	} | null;
}

/** The response of a detail batch query: the PR at index `i` is `pr<i>`, with `dn<i>` and `up<i>` for its stack. */
interface BatchData {
	repository: ({ defaultBranchRef: { name: string; target: { oid: string } | null } | null } & Record<string, unknown>) | null;
}

interface CompareData {
	behind_by: number;
	merge_base_commit: { commit: { committer: { date: string } | null } } | null;
}

interface RawText {
	author: { login: string; __typename?: string } | null;
	body: string | null;
	url: string;
}

interface RawFollowUpPr {
	url: string;
	body: string | null;
	createdAt: string;
	author: { login: string; __typename?: string } | null;
	headRefOid: string;
	/** Only the last commit, for when the code last changed. */
	commits: { nodes: { commit: { committedDate: string } }[] };
	reviews: { nodes: (RawText & { submittedAt: string | null; commit: { oid: string } | null })[] };
	comments: { nodes: (RawText & { createdAt: string })[] };
	reviewThreads: {
		nodes: { isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null; comments: { nodes: (RawText & { createdAt: string })[] } }[];
	};
}

interface FollowUpsData {
	repository: Record<string, RawFollowUpPr | null> | null;
}

interface RefsData {
	repository: { pullRequest: { headRefName: string; baseRefName: string } | null } | null;
}

// ---------------------------------------------------------------------------
// Queries

/** The fork owner's login when the head branch is in another repo (`ghost` when the fork was deleted); null otherwise. */
const forkOwner = (pr: { isCrossRepository: boolean; headRepositoryOwner: { login: string } | null }): string | null =>
	pr.isCrossRepository ? (pr.headRepositoryOwner?.login ?? 'ghost') : null;

// The list, merged and detail queries are in queries.ts, so a host that ports this data layer can ask for the same fields.

// Every author has `__typename`, because a GitHub App is typed `Bot` whatever its login is.
const FOLLOWUP_FIELDS = `
	url body createdAt author { login __typename } headRefOid
	commits(last:1) { nodes { commit { committedDate } } }
	reviews(last:50) { nodes { author { login __typename } body url submittedAt commit { oid } } }
	comments(last:100) { nodes { author { login __typename } body url createdAt } }
	reviewThreads(first:100) { nodes { isResolved isOutdated path line comments(first:10) { nodes { author { login __typename } body url createdAt } } } }`;

/** Several PRs of one repo in one query, aliased p0, p1, ... The numbers are integers, so they are safe to inline. */
const followUpsQuery = (numbers: number[]) => `query($owner:String!, $name:String!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		${numbers.map((n, i) => `p${i}: pullRequest(number:${Math.trunc(n)}) { ${FOLLOWUP_FIELDS} }`).join('\n\t\t')}
	}
}`;

const REFS_QUERY = `query($owner:String!, $name:String!, $n:Int!) {
	repository(owner:$owner, name:$name) { pullRequest(number:$n) { headRefName baseRefName } }
}`;

// ---------------------------------------------------------------------------
// Parsing helpers (exported for tests and reuse)

export function prKey(host: string, owner: string, repo: string, number: number | string): string {
	return `${host}:${owner}/${repo}#${number}`;
}

/** The reverse of prKey, or null when `key` is not one. */
export function parsePrKey(key: string): PrTarget | null {
	const m = /^(.+):([\w.-]+)\/([\w.-]+)#(\d{1,9})$/.exec(key);
	return m ? { host: m[1]!, owner: m[2]!, repo: m[3]!, number: Number(m[4]) } : null;
}

/**
 * Parses an AI-review bot's inline comment. Bots that open with a bold title followed by
 * `·`-separated tags (`**Title** · fix here · medium`) get a severity and kind; an optional
 * `<!-- ai-review:inline <id> <category> <area> -->` marker supplies the category. Any other
 * comment still counts, as severity "info".
 */
export function parseBotFinding(body: string): Pick<BotFinding, 'title' | 'severity' | 'kind' | 'category' | 'belowThreshold'> {
	const text = body.replace(/<!--[\s\S]*?-->/g, '').trim();
	const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
	const m = firstLine.match(/^\*\*(.+?)\*\*(.*)$/);
	const title = (m?.[1] ?? firstLine).trim();
	const tail = (m?.[2] ?? '')
		.split('·')
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	const isSeverity = (t: string): t is Severity => (SEVERITIES as readonly string[]).includes(t);
	const severity = tail.find(isSeverity) ?? 'info';
	const kind = tail.find((t) => !isSeverity(t) && !t.startsWith('below')) ?? 'finding';
	const marker = body.match(/<!--\s*ai-review:inline\s+\S+\s+(\S+)\s+(\S+)\s*-->/);
	return {
		title: title.slice(0, 220),
		severity,
		kind,
		category: marker?.[1]?.replace(/_/g, ' ') ?? null,
		belowThreshold: tail.some((t) => t.startsWith('below')),
	};
}

export function extractLinear(text: string | null | undefined, keys: string[]): Set<string> {
	const found = new Set<string>();
	if (!text) return found;
	const keyRe = linearKeyRegExp(keys);
	if (keyRe) for (const m of text.matchAll(keyRe)) found.add(`${m[1]!.toUpperCase()}-${m[2]}`);
	for (const m of text.matchAll(/linear\.app\/[\w-]+\/issue\/([A-Za-z]+-\d+)/g)) found.add(m[1]!.toUpperCase());
	return found;
}

export function extractRefs(body: string | null, hostByHostname: Map<string, string>): { refs: PrRef[]; hashRefs: number[] } {
	const refs: PrRef[] = [];
	const seen = new Set<string>();
	for (const m of (body ?? '').matchAll(/https:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g)) {
		const host = hostByHostname.get(m[1]!);
		if (!host) continue;
		const key = prKey(host, m[2]!, m[3]!, m[4]!);
		if (seen.has(key)) continue;
		seen.add(key);
		refs.push({ key, host, owner: m[2]!, repo: m[3]!, number: Number(m[4]), url: m[0] });
	}
	const hashRefs = [...new Set([...(body ?? '').matchAll(/(?:^|[\s(,])#(\d{1,7})\b/g)].map((m) => Number(m[1])))];
	return { refs, hashRefs };
}

// ---------------------------------------------------------------------------
// Service

export interface DetailRequest {
	host: string;
	owner: string;
	repo: string;
	number: number | string;
	head?: string | undefined;
	base?: string | undefined;
	force?: boolean;
	/** Accept a cached detail up to this old. */
	maxAgeMs?: number;
}

/** `total` is what GitHub matched; it is larger than `prs.length` when the 500-result cap cut the list. */
export interface MergedList {
	prs: MergedPr[];
	total: number;
}

export interface PrTarget {
	host: string;
	owner: string;
	repo: string;
	number: number;
}

export interface PrService {
	readonly hostKeys: string[];
	/** Reuses a list for LIST_TTL_MS, or LIST_MODE_TTL_MS when `refresh` is "list". A low budget still reuses the last list, and calls at the same time share one search. */
	listHost(hostKey: string, reviewerIds: string[]): Promise<{ prs: LightPr[]; throttled: boolean }>;
	/** The team's PRs merged in the last MERGED_FETCH_DAYS days; callers filter to a range. */
	listMerged(hostKey: string): Promise<MergedList>;
	/**
	 * The details of one PR, as a batch of one. A cached detail that is fresh enough, or a call in flight for the same PR
	 * (from another caller or from `prefetchDetails`), answers without a query. At a low budget the cached detail answers
	 * whatever its age. Rejects with NotFoundError when the PR does not exist.
	 */
	getDetail(req: DetailRequest): Promise<PrDetail>;
	/**
	 * `getDetail` for several PRs, one promise per request in the same order. The PRs that need a query are grouped by
	 * host and repository and sent BATCH_MAX to a query, so one request costs one `gh` process for up to 10 PRs. A PR that
	 * the answer lacks, or a query that fails, rejects only the promises of its own PRs. A failure is never held back:
	 * a later call sends a query again.
	 */
	getDetails(reqs: DetailRequest[]): Promise<PrDetail>[];
	/**
	 * Starts fetching, in the background, the details that `/api/prs` does not have: the PRs that are not dormant, plus
	 * those that have a review request, grouped like `getDetails`. It sends nothing for a PR that has a detail for this
	 * `updatedAt`, one that is already being fetched, or one whose last batch failed less than a minute ago; nothing at all
	 * for a host with a low budget (under 150 points) or a host in `throttled`, and no batch that would take the host under 150 points (the cost of
	 * a batch is estimated before it is sent, and the PRs it leaves out are left to `getDetail` and the next list); and in `"list"` mode, nothing for a PR with a
	 * detail under 10 seconds old. Every PR is registered as in flight before this returns, so a `getDetail` call for it
	 * waits for the batch and sends no query. The returned promise settles when every batch has, never rejects, and callers
	 * need not wait for it. A failed batch is logged to the console and nowhere else: the PRs just have no detail, and the
	 * page asks for them one by one.
	 */
	prefetchDetails(prs: LightPr[], throttled?: Record<string, boolean>): Promise<void>;
	/** The cached details of a PR, only when they are for this `updatedAt`. Never calls GitHub. */
	cachedDetail(key: string, updatedAt: string): PrDetail | null;
	/** Follow-ups per PR key, cached; uncached PRs of one repo are fetched FOLLOWUPS_BATCH per query. */
	getFollowUps(targets: PrTarget[]): Promise<FollowUpsResponse>;
}

export class NotFoundError extends Error {
	readonly status = 404;
}

export function createPrService(config: Config, gh: GhRunner): PrService {
	const teamById = new Map(config.team.map((m) => [m.id, m]));
	const hostKeys = [...new Set(config.repos.map((r) => r.host))];
	const hostByHostname = new Map(Object.entries(config.hosts).map(([k, h]) => [h.hostname, k]));
	const loginFor = (member: TeamMember | undefined, hostKey: string): string | undefined => member?.logins[hostKey];
	const linearKeys = config.linear?.keys ?? [];

	const botLogins = new Set([
		...allReviewBots(config),
		...(config.ignoreParticipants ?? []).filter(Boolean).map((l) => l.toLowerCase()),
	]);
	const isBot = (login: string | undefined): boolean =>
		!login || botLogins.has(login.toLowerCase()) || /\[bot\]$|-bot$|^app\//i.test(login);

	// ---- list ----

	const listCache = new Map<string, { at: number; prs: LightPr[] }>();
	const listInflight = new Map<string, Promise<{ prs: LightPr[]; throttled: boolean }>>();
	// In "list" mode, the last failed search per cache key, so calls in the next LIST_MODE_TTL_MS get its error.
	const listFailed = new Map<string, { at: number; error: unknown }>();

	/** Up to 5 pages of one search, and how many results GitHub found in all. */
	async function searchAll<T extends object>(hostKey: string, q: string, query: string): Promise<{ nodes: T[]; total: number }> {
		const nodes: T[] = [];
		let total = 0;
		let after: string | null = null;
		for (let page = 0; page < 5; page++) {
			const data: SearchData<T> = await gh.query<SearchData<T>>(hostKey, query, { q, after });
			total = data.search.issueCount;
			for (const n of data.search.nodes) if (n && 'number' in n) nodes.push(n as T);
			if (!data.search.pageInfo.hasNextPage) break;
			after = data.search.pageInfo.endCursor;
		}
		return { nodes, total };
	}

	function lightPr(hostKey: string, n: RawLightPr): LightPr {
		const owner = n.repository.owner.login;
		const repo = n.repository.name;
		return {
			key: prKey(hostKey, owner, repo, n.number),
			host: hostKey,
			owner,
			repo,
			number: n.number,
			title: n.title,
			url: n.url,
			isDraft: n.isDraft,
			updatedAt: n.updatedAt,
			createdAt: n.createdAt,
			headRefName: n.headRefName,
			baseRefName: n.baseRefName,
			fork: forkOwner(n),
			author: { login: n.author?.login ?? 'ghost', name: n.author?.name ?? null },
			authoredByTeam: false,
			inAllAuthorsRepo: false,
			requestedFor: [],
			teamRequested: false,
		};
	}

	/** Search qualifiers for the tracked repos and the team's authors on one host. */
	function teamScope(hostKey: string): { repos: string; authors: string } {
		const repos = config.repos
			.filter((x) => x.host === hostKey)
			.map((x) => `repo:${x.owner}/${x.name}`)
			.join(' ');
		const authors = config.team
			.map((m) => loginFor(m, hostKey))
			.filter((l): l is string => Boolean(l))
			.map((l) => `author:${l}`)
			.join(' ');
		return { repos, authors };
	}

	function listHost(hostKey: string, reviewerIds: string[]) {
		const listMode = config.refresh === 'list';
		const cacheKey = `${hostKey}|${reviewerIds.join(',')}`;
		const cached = listCache.get(cacheKey);
		const r = gh.rate[hostKey];
		if (cached && r && r.remaining < LOW_BUDGET_LIST && Date.now() - cached.at < 5 * 60_000) {
			return Promise.resolve({ prs: cached.prs, throttled: true });
		}
		if (cached && Date.now() - cached.at < (listMode ? LIST_MODE_TTL_MS : LIST_TTL_MS)) return Promise.resolve({ prs: cached.prs, throttled: false });
		// Calls at the same time share one search, also from many pages.
		const pending = listInflight.get(cacheKey);
		if (pending) return pending;
		const failed = listFailed.get(cacheKey);
		if (listMode && failed && Date.now() - failed.at < LIST_MODE_TTL_MS) return Promise.reject(failed.error);
		const p = searchHost(hostKey, reviewerIds, cacheKey)
			.then(
				(v) => {
					listFailed.delete(cacheKey);
					return v;
				},
				(e: unknown) => {
					if (listMode) listFailed.set(cacheKey, { at: Date.now(), error: e });
					throw e;
				}
			)
			.finally(() => listInflight.delete(cacheKey));
		listInflight.set(cacheKey, p);
		return p;
	}

	async function searchHost(hostKey: string, reviewerIds: string[], cacheKey: string) {
		const { repos, authors } = teamScope(hostKey);
		// Repos with allAuthors list every open PR, so they skip the author filter. That search also finds the team's PRs.
		const hostRepos = config.repos.filter((x) => x.host === hostKey);
		const qualifiers = (list: typeof hostRepos) => list.map((x) => `repo:${x.owner}/${x.name}`).join(' ');
		const teamRepos = qualifiers(hostRepos.filter((x) => !x.allAuthors));
		const allAuthorsRepos = qualifiers(hostRepos.filter((x) => x.allAuthors));
		const teamLogins = new Set(config.team.map((m) => loginFor(m, hostKey)?.toLowerCase()).filter(Boolean));
		const searches: { kind: 'team' | 'allAuthors' | 'review' | 'teamReview'; id?: string; q: string }[] = [];
		if (authors && teamRepos) searches.push({ kind: 'team', q: `is:pr is:open ${teamRepos} ${authors}` });
		if (allAuthorsRepos) searches.push({ kind: 'allAuthors', q: `is:pr is:open ${allAuthorsRepos}` });
		for (const id of reviewerIds) {
			const login = loginFor(teamById.get(id), hostKey);
			if (login) searches.push({ kind: 'review', id, q: `is:pr is:open ${repos} user-review-requested:${login}` });
		}
		// Review teams are searched whatever the bells say: a team request waits on everyone in the team.
		// Drafts never wait on a team (see src/waiting.ts), so skip them and their detail fetches.
		for (const slug of config.hosts[hostKey]?.reviewTeams ?? []) {
			searches.push({ kind: 'teamReview', q: `is:pr is:open draft:false ${repos} team-review-requested:${slug}` });
		}

		const results = await Promise.all(searches.map((s) => searchAll<RawLightPr>(hostKey, s.q, SEARCH_QUERY)));
		const byKey = new Map<string, LightPr>();
		searches.forEach((s, i) => {
			for (const node of results[i]?.nodes ?? []) {
				const pr = lightPr(hostKey, node);
				const existing = byKey.get(pr.key) ?? pr;
				if (s.kind === 'team') existing.authoredByTeam = true;
				else if (s.kind === 'allAuthors') {
					existing.inAllAuthorsRepo = true;
					if (teamLogins.has(existing.author.login.toLowerCase())) existing.authoredByTeam = true;
				}
				else if (s.kind === 'teamReview') existing.teamRequested = true;
				else if (s.id) existing.requestedFor.push(s.id);
				byKey.set(pr.key, existing);
			}
		});
		const prs = [...byKey.values()];
		listCache.set(cacheKey, { at: Date.now(), prs });
		return { prs, throttled: false };
	}

	// ---- merged ----

	const mergedCache = new Map<string, { at: number; value: MergedList }>();
	const mergedInflight = new Map<string, Promise<MergedList>>();

	function listMerged(hostKey: string): Promise<MergedList> {
		const cached = mergedCache.get(hostKey);
		const r = gh.rate[hostKey];
		const ttl = r && r.remaining < LOW_BUDGET_LIST ? 5 * 60_000 : MERGED_TTL_MS;
		if (cached && Date.now() - cached.at < ttl) return Promise.resolve(cached.value);
		const pending = mergedInflight.get(hostKey);
		if (pending) return pending;

		const p = (async () => {
			// One search per host, like the open list; GitHub accepted 120 author: qualifiers in one query when tried.
			const { repos, authors } = teamScope(hostKey);
			// Newest first, so a search with more than 500 results drops the oldest merges.
			const q = `is:pr is:merged merged:>=${mergedSearchSince(new Date())} ${repos} ${authors} sort:updated-desc`;
			const { nodes, total } = authors ? await searchAll<RawMergedPr>(hostKey, q, MERGED_SEARCH_QUERY) : { nodes: [], total: 0 };
			const prs = nodes.map((n): MergedPr => {
				const owner = n.repository.owner.login;
				const repo = n.repository.name;
				return {
					key: prKey(hostKey, owner, repo, n.number),
					host: hostKey,
					owner,
					repo,
					number: n.number,
					title: n.title,
					url: n.url,
					author: n.author?.login ?? 'ghost',
					mergedAt: n.mergedAt,
				};
			});
			const value = { prs, total };
			mergedCache.set(hostKey, { at: Date.now(), value });
			return value;
		})().finally(() => mergedInflight.delete(hostKey));
		mergedInflight.set(hostKey, p);
		return p;
	}

	// ---- detail ----

	const detailCache = new Map<string, { at: number; value: PrDetail }>();
	// A PR that is being fetched, by key. Every fetch registers its PRs here, so a caller for the same PR waits for it.
	const inflight = new Map<string, Promise<PrDetail>>();
	// PRs whose detail batch failed, and when. Only `prefetchDetails` reads it: a call for one PR (the page's fallback, MCP) still tries.
	const prefetchHeld = new Map<string, number>();

	function shapeBot(hostKey: string, owner: string, repo: string, pr: RawDetailPr): BotSummary | null {
		const bot = reviewBot(config, hostKey, owner, repo);
		if (!bot) return null;
		const login = bot.toLowerCase();
		const findings: BotFinding[] = [];
		for (const t of pr.reviewThreads.nodes) {
			const first = t.comments.nodes[0];
			if (!first || first.author?.login?.toLowerCase() !== login || t.isResolved) continue;
			findings.push({
				...parseBotFinding(first.body ?? ''),
				outdated: t.isOutdated,
				url: first.url,
				path: t.path,
				line: t.line,
				createdAt: first.createdAt,
			});
		}
		const isBlocking = (f: BotFinding) =>
			f.kind !== 'nit' && !f.belowThreshold && (['critical', 'high', 'medium'] as Severity[]).includes(f.severity);
		const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length])) as Record<Severity, number>;
		return {
			login: bot,
			open: findings.length,
			blocking: findings.filter(isBlocking).length,
			outdated: findings.filter((f) => f.outdated).length,
			bySeverity,
			findings,
		};
	}

	function shapeParticipants(pr: RawDetailPr): { participants: Participant[]; lastActive: Map<string, string>; lastActivity: LastActivity | null } {
		const lastActive = new Map<string, string>();
		let lastActivity: LastActivity | null = null;
		// A GitHub App such as github-actions has no `[bot]` suffix, but GitHub types it `Bot`. A login that is typed `Bot`
		// anywhere in the PR is a bot everywhere in it, so the result does not depend on the order of the events.
		const typedBots = new Set<string>();
		const typed = (a: RawAuthor | null | undefined) => {
			if (a?.__typename === 'Bot') typedBots.add(a.login);
		};
		for (const c of pr.comments.nodes) typed(c.author);
		for (const r of pr.reviews.nodes) typed(r.author);
		for (const t of pr.reviewThreads.nodes) typed(t.comments.nodes[0]?.author);
		const isBotActor = (login: string) => typedBots.has(login) || isBot(login);
		const touch = (login: string | undefined, at: string | null | undefined, kind: LastActivity['kind']) => {
			if (!login || !at) return;
			const prev = lastActive.get(login);
			if (!prev || prev < at) lastActive.set(login, at);
			if (!isBotActor(login) && (!lastActivity || lastActivity.at < at)) lastActivity = { login, at, kind };
		};
		for (const c of pr.comments.nodes) touch(c.author?.login, c.createdAt, 'comment');
		for (const r of pr.reviews.nodes) touch(r.author?.login, r.submittedAt, 'review');
		for (const t of pr.reviewThreads.nodes) touch(t.comments.nodes[0]?.author?.login, t.comments.nodes[0]?.createdAt, 'review');
		for (const c of pr.commits.nodes) touch(c.commit.author?.user?.login, c.commit.committedDate, 'commit');
		// Participation means a comment, a review or a commit; mentions and review requests alone don't count.
		const authorLogin = pr.author?.login;
		const nameByLogin = new Map(pr.participants.nodes.map((p) => [p.login, p.name]));
		const participants = [...lastActive.entries()]
			.filter(([login]) => login !== authorLogin && !isBotActor(login))
			.map(([login, at]) => ({ login, name: nameByLogin.get(login) ?? null, lastActive: at }))
			.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
		return { participants, lastActive, lastActivity };
	}

	function shapeDetail(hostKey: string, owner: string, repo: string, data: DetailData): PrDetail | null {
		const pr = data.repository?.pullRequest;
		if (!pr || !data.repository) return null;
		const key = prKey(hostKey, owner, repo, pr.number);

		const linear = new Set<string>();
		if (config.linear) {
			for (const k of extractLinear(`${pr.title}\n${pr.headRefName}`, linearKeys)) linear.add(k);
			for (const k of extractLinear(pr.body, linearKeys)) linear.add(k);
		}
		const { refs, hashRefs } = extractRefs(pr.body, hostByHostname);

		const users: PrDetail['requested']['users'] = [];
		const teams: PrDetail['requested']['teams'] = [];
		const reviewTeams = (config.hosts[hostKey]?.reviewTeams ?? []).map((t) => t.toLowerCase());
		for (const n of pr.reviewRequests.nodes) {
			const r = n.requestedReviewer;
			if (r && r.__typename === 'User' && 'login' in r) users.push({ login: r.login, name: r.name });
			else if (r && r.__typename === 'Team' && 'slug' in r) teams.push({ slug: r.slug, combinedSlug: r.combinedSlug, name: r.name, reviewTeam: reviewTeams.includes(r.combinedSlug.toLowerCase()) });
		}
		const mini = (p: RawMiniPr): MiniPr => ({ number: p.number, title: p.title, url: p.url, author: p.author?.login ?? 'ghost' });
		const { participants, lastActive, lastActivity } = shapeParticipants(pr);
		const parent = data.repository.parent?.nodes[0];

		return {
			key,
			host: hostKey,
			owner,
			repo,
			number: pr.number,
			title: pr.title,
			url: pr.url,
			state: pr.merged ? 'MERGED' : pr.state,
			mergedAt: pr.mergedAt,
			isDraft: pr.isDraft,
			updatedAt: pr.updatedAt,
			createdAt: pr.createdAt,
			headRefName: pr.headRefName,
			baseRefName: pr.baseRefName,
			fork: forkOwner(pr),
			author: { login: pr.author?.login ?? 'ghost', name: pr.author?.name ?? null },
			mergeable: pr.mergeable,
			reviewDecision: pr.reviewDecision,
			checks: pr.statusCheckRollup?.state ?? null,
			size: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
			requested: { users, teams },
			reviews: pr.latestOpinionatedReviews.nodes.map((r) => ({
				login: r.author?.login ?? 'ghost',
				state: r.state,
				submittedAt: r.submittedAt,
			})),
			bot: shapeBot(hostKey, owner, repo, pr),
			participants,
			authorLastActive: (pr.author && lastActive.get(pr.author.login)) ?? null,
			lastActivity,
			lastCommitAt: pr.commits.nodes.map((c) => c.commit.committedDate).sort().at(-1) ?? null,
			linear: [...linear],
			refs: refs.filter((r) => r.key !== key),
			hashRefs: hashRefs.filter((n) => n !== pr.number),
			parent: parent ? mini(parent) : null,
			stackedOnThis: data.repository.stackedOnThis.nodes.map(mini),
			baseAge: null,
			fetchedAt: new Date().toISOString(),
		};
	}

	// ---- base age ----

	// Keyed by the head commit and the base branch name, not its tip: on a busy repo the tip moves all the time,
	// but the merge base only changes when the head does.
	const baseAgeCache = new Map<string, { at: number; value: BaseAge }>();

	async function baseAge(hostKey: string, owner: string, repo: string, data: DetailData): Promise<BaseAge | null> {
		const pr = data.repository?.pullRequest;
		if (!pr || pr.merged || pr.state !== 'OPEN') return null;
		if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null; // they go into a REST path
		// A stacked PR's base is another PR's branch; what matters is how far behind the default branch it is.
		const repoDefault = data.repository?.defaultBranchRef;
		const def = data.repository?.parent?.nodes.length ? repoDefault : null;
		const against = def?.target ? def.name : pr.baseRefName;
		const againstOid = def?.target ? def.target.oid : (pr.baseRef?.target?.oid ?? pr.baseRefOid);
		// The limit is about the default branch; a PR into a release branch, say, only gets the age.
		const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
		const limitHours =
			against === repoDefault?.name
				? (config.repos.find((r) => r.host === hostKey && same(r.owner, owner) && same(r.name, repo))?.maxBaseAgeHours ?? null)
				: null;

		const key = `${hostKey}:${owner}/${repo}:${against}...${pr.headRefOid}`;
		const hit = baseAgeCache.get(key);
		if (hit && Date.now() - hit.at < (hit.value.mergeBaseAt ? BASE_AGE_TTL_MS : BASE_AGE_RETRY_MS)) return hit.value;

		let value: BaseAge;
		let at = Date.now();
		try {
			// GitHub lists changed files (with patches) on page 1 only; page 2 keeps behind_by and the merge base without them.
			const c = await gh.get<CompareData>(hostKey, `repos/${owner}/${repo}/compare/${againstOid}...${pr.headRefOid}?per_page=1&page=2`);
			const date = c.merge_base_commit?.commit.committer?.date ?? null;
			value = date
				? { against, mergeBaseAt: date, behindBy: c.behind_by, limitHours }
				: { against, mergeBaseAt: null, behindBy: null, limitHours, error: 'No merge base' };
		} catch (e) {
			if (hit?.value.mergeBaseAt) {
				// Same head, so the known merge base still holds; keep it and try again in a minute.
				value = hit.value;
				at = Date.now() - BASE_AGE_TTL_MS + BASE_AGE_RETRY_MS;
			} else {
				value = { against, mergeBaseAt: null, behindBy: null, limitHours, error: (e as Error).message.slice(0, 200) };
			}
		}
		baseAgeCache.delete(key);
		if (baseAgeCache.size >= BASE_AGE_CACHE_MAX) baseAgeCache.delete(baseAgeCache.keys().next().value!);
		baseAgeCache.set(key, { at, value });
		return value;
	}

	/** The batch response for the PR at index `i`, in the per-PR shape that shapeDetail and baseAge read. */
	function detailAt(data: BatchData, i: number): DetailData {
		const repo = data.repository;
		if (!repo) return { repository: null };
		return {
			repository: {
				defaultBranchRef: repo.defaultBranchRef,
				pullRequest: (repo[`pr${i}`] as RawDetailPr | null | undefined) ?? null,
				parent: (repo[`up${i}`] as { nodes: RawMiniPr[] } | null | undefined) ?? undefined,
				stackedOnThis: (repo[`dn${i}`] as { nodes: RawMiniPr[] } | null | undefined) ?? { nodes: [] },
			},
		};
	}

	const lowBudget = (host: string): boolean => {
		const r = gh.rate[host];
		return Boolean(r && r.remaining < LOW_BUDGET_DETAIL);
	};

	/** What a call for one PR may answer without a query: the cached detail (at a low budget, whatever its age), or the fetch in flight. */
	function reusable(req: DetailRequest, key: string): PrDetail | Promise<PrDetail> | null {
		const cached = detailCache.get(key);
		if (cached && lowBudget(req.host)) return { ...cached.value, throttled: true };
		const ttl = Math.max(req.maxAgeMs ?? (req.force ? FORCED_DETAIL_TTL_MS : DETAIL_TTL_MS), config.refresh === 'list' ? LIST_MODE_TTL_MS : 0);
		if (cached && Date.now() - cached.at < ttl) return cached.value;
		return inflight.get(key) ?? null;
	}

	/** Registers a fetch as the one in flight for `key`, until it settles. The caller owns the returned promise and must handle its failure. */
	function track(key: string, p: Promise<PrDetail>): Promise<PrDetail> {
		const tracked: Promise<PrDetail> = p.finally(() => {
			if (inflight.get(key) === tracked) inflight.delete(key);
		});
		inflight.set(key, tracked);
		return tracked;
	}

	interface BatchItem {
		key: string;
		number: number;
		head: string;
		base: string;
	}
	interface RepoBatch {
		host: string;
		owner: string;
		repo: string;
		items: BatchItem[];
	}

	/**
	 * One query for 1 to BATCH_MAX PRs of one repo; one promise per PR, in order. Each PR is shaped, given its base age and
	 * cached on its own: a PR that the answer lacks (`pr<i>: null`) rejects with NotFoundError and the others still resolve,
	 * and a query that fails rejects them all. The PR at index `i` is `pr<i>`, the PRs stacked on it are `dn<i>`, and its
	 * parent is `up<i>` (only when its base is not a default branch).
	 */
	function fetchDetails(host: string, owner: string, repo: string, items: BatchItem[]): Promise<PrDetail>[] {
		const answer = (async () => {
			const { query, variables } = buildDetailBatch({ owner, name: repo, prs: items.map(({ number, head, base }) => ({ number, head, base })) });
			return gh.query<BatchData>(host, query, variables);
		})();
		return items.map(async (item, i) => {
			const data = detailAt(await answer, i);
			const value = shapeDetail(host, owner, repo, data);
			if (!value) throw new NotFoundError('Pull request not found');
			value.baseAge = await baseAge(host, owner, repo, data);
			detailCache.set(item.key, { at: Date.now(), value });
			return value;
		});
	}

	/**
	 * Sends one query for each BATCH_MAX PRs of each repo, and registers every PR as in flight before the first await.
	 * With `reserve`, a chunk is sent only when it returns a release function (null: not sent, and its PRs are not registered).
	 */
	function startBatches(batches: Iterable<RepoBatch>, reserve?: (host: string, cost: number) => (() => void) | null): Map<string, Promise<PrDetail>> {
		const started = new Map<string, Promise<PrDetail>>();
		for (const b of batches) {
			for (let i = 0; i < b.items.length; i += BATCH_MAX) {
				const chunk = b.items.slice(i, i + BATCH_MAX);
				const release = reserve ? reserve(b.host, chunk.length + 1) : () => {};
				if (!release) break; // the rest of this repo's PRs are left to the row calls and the next list
				const fetched = fetchDetails(b.host, b.owner, b.repo, chunk);
				void Promise.allSettled(fetched).then(release);
				fetched.forEach((p, j) => {
					const tracked = track(chunk[j]!.key, p);
					tracked.catch(() => {}); // a caller that does not wait for a PR must not crash the server when its batch fails
					started.set(chunk[j]!.key, tracked);
				});
			}
		}
		return started;
	}

	/** Adds a PR to the batch of its host and repo. The host is part of the id: two hosts can have a repo with the same name. */
	function addToBatch(batches: Map<string, RepoBatch>, host: string, owner: string, repo: string, item: BatchItem): void {
		const id = `${host}\0${owner}/${repo}`;
		const batch = batches.get(id) ?? { host, owner, repo, items: [] };
		batch.items.push(item);
		batches.set(id, batch);
	}

	async function getDetail(req: DetailRequest): Promise<PrDetail> {
		const { host, owner, repo } = req;
		const number = Number(req.number);
		if (!Number.isInteger(number) || number < 1) throw new NotFoundError('Pull request not found');
		const key = prKey(host, owner, repo, number);
		const reused = reusable(req, key);
		if (reused) return reused;

		return track(
			key,
			(async () => {
				// Callers that only know the number (e.g. MCP agents) get the branches looked up first,
				// so the stacked-parent lookup still works.
				let head = req.head || detailCache.get(key)?.value.headRefName;
				let base = req.base || detailCache.get(key)?.value.baseRefName;
				if (!head || !base) {
					const refs = await gh.query<RefsData>(host, REFS_QUERY, { owner, name: repo, n: number });
					const pr = refs.repository?.pullRequest;
					if (!pr) throw new NotFoundError('Pull request not found');
					head = pr.headRefName;
					base = pr.baseRefName;
				}
				return fetchDetails(host, owner, repo, [{ key, number, head, base }])[0]!;
			})()
		);
	}

	function getDetails(reqs: DetailRequest[]): Promise<PrDetail>[] {
		const keys = reqs.map((r) => prKey(r.host, r.owner, r.repo, Number(r.number)));
		const answers = new Map<string, Promise<PrDetail>>();
		const queued = new Set<string>();
		const batches = new Map<string, RepoBatch>();
		reqs.forEach((req, i) => {
			const key = keys[i]!;
			if (answers.has(key) || queued.has(key)) return;
			const number = Number(req.number);
			const valid = Number.isInteger(number) && number >= 1;
			const reused = valid ? reusable(req, key) : null;
			if (reused) {
				answers.set(key, Promise.resolve(reused));
				return;
			}
			const head = req.head || detailCache.get(key)?.value.headRefName;
			const base = req.base || detailCache.get(key)?.value.baseRefName;
			if (!valid || !head || !base) {
				// A number that is no PR number, or branches that are looked up first: `getDetail` handles it.
				answers.set(key, getDetail(req));
				return;
			}
			queued.add(key);
			addToBatch(batches, req.host, req.owner, req.repo, { key, number, head, base });
		});
		for (const [key, p] of startBatches(batches.values())) answers.set(key, p);
		return keys.map((k) => answers.get(k)!);
	}

	// Points that the prefetch has asked GitHub for and not yet seen in `gh.rate`, by host (a batch of n PRs is estimated at n + 1).
	const unseenCost = new Map<string, number>();

	/** The prefetch sends a batch only when the host would still have LOW_BUDGET_DETAIL points after it. Returns what to call when the batch is answered, or null. */
	function reserve(host: string, cost: number): (() => void) | null {
		const r = gh.rate[host];
		if (r && r.remaining - (unseenCost.get(host) ?? 0) - cost < LOW_BUDGET_DETAIL) return null;
		unseenCost.set(host, (unseenCost.get(host) ?? 0) + cost);
		return () => void unseenCost.set(host, (unseenCost.get(host) ?? 0) - cost);
	}

	function prefetchDetails(list: LightPr[], throttled: Record<string, boolean> = {}): Promise<void> {
		const now = Date.now();
		const seen = new Set<string>();
		for (const [key, at] of prefetchHeld) if (now - at >= DETAIL_HOLD_MS) prefetchHeld.delete(key);
		const listMode = config.refresh === 'list';
		const batches = new Map<string, RepoBatch>();
		for (const pr of list) {
			const dormant = now - new Date(pr.updatedAt).getTime() > DORMANT_MS;
			if (dormant && !pr.requestedFor.length && !pr.teamRequested) continue;
			if (throttled[pr.host] || lowBudget(pr.host)) continue;
			if (seen.has(pr.key) || inflight.has(pr.key) || prefetchHeld.has(pr.key)) continue;
			seen.add(pr.key);
			const cached = detailCache.get(pr.key);
			// A detail for this `updatedAt` is current. In "list" mode, one under 10 seconds old is kept even when the PR changed.
			if (cached && (cached.value.updatedAt === pr.updatedAt || (listMode && now - cached.at < LIST_MODE_TTL_MS))) continue;
			addToBatch(batches, pr.host, pr.owner, pr.repo, { key: pr.key, number: pr.number, head: pr.headRefName, base: pr.baseRefName });
		}
		const failed: string[] = [];
		const settled = [...startBatches(batches.values(), reserve)].map(([key, p]) =>
			p.then(
				() => void prefetchHeld.delete(key),
				(e: unknown) => {
					prefetchHeld.set(key, Date.now());
					failed.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
				}
			)
		);
		return Promise.all(settled).then(() => {
			if (failed.length) {
				console.error(`Details of ${failed.length} PR${failed.length === 1 ? '' : 's'} could not be fetched; the list skips them for ${DETAIL_HOLD_MS / 1000} seconds. First: ${failed[0]!.slice(0, 300)}`);
			}
		});
	}

	function cachedDetail(key: string, updatedAt: string): PrDetail | null {
		const value = detailCache.get(key)?.value;
		return value && value.updatedAt === updatedAt ? value : null;
	}

	// ---- follow-ups ----

	const followUpsCache = new Map<string, { at: number; value: FollowUp[] }>();
	const followUpsInflight = new Map<string, Promise<FollowUp[]>>();

	function shapeFollowUps(hostKey: string, owner: string, repo: string, pr: RawFollowUpPr): FollowUp[] {
		const bot = reviewBot(config, hostKey, owner, repo)?.toLowerCase();
		const texts: FollowUpText[] = [];
		// A GitHub App such as github-actions has no `[bot]` suffix, but GitHub types it `Bot`. As in shapeParticipants,
		// a login that is typed `Bot` anywhere in the PR is a bot everywhere in it.
		const typedBots = new Set<string>();
		const typed = (t: RawText) => {
			if (t.author?.__typename === 'Bot') typedBots.add(t.author.login);
		};
		typed(pr);
		for (const r of pr.reviews.nodes) typed(r);
		for (const c of pr.comments.nodes) typed(c);
		for (const t of pr.reviewThreads.nodes) for (const c of t.comments.nodes) typed(c);
		const add = (t: RawText, source: FollowUpText['source'], at: string | null, stale: boolean, path?: string | null, line?: number | null) => {
			const login = t.author?.login;
			// The AI-review bot's findings already have their own column; other bots are noise here.
			if (!login || isBot(login) || typedBots.has(login)) return;
			// A reply addressed to the bot ("@bot rejected: ...") answers a finding; it asks nothing of the author.
			if (bot && t.body?.trimStart().toLowerCase().startsWith(`@${bot}`) && !/^[\w-]/.test(t.body.trimStart().slice(bot.length + 1))) return;
			texts.push({ author: login, source, body: t.body, url: t.url, at, path, line, stale });
		};
		// An ask written before the last commit may be done by it. Nothing in the data says which asks a commit
		// handled, so all of them stop counting: a wrong flag costs more than a missed one. The description is
		// kept, because it is edited along the way and describes the final code.
		const lastCommitAt = pr.commits.nodes[0]?.commit.committedDate ?? null;
		const before = (at: string | null) => Boolean(lastCommitAt && at && at < lastCommitAt);
		add(pr, 'description', pr.createdAt, false);
		for (const r of pr.reviews.nodes) add(r, 'review', r.submittedAt, (r.commit ? r.commit.oid !== pr.headRefOid : false) || before(r.submittedAt));
		for (const c of pr.comments.nodes) add(c, 'comment', c.createdAt, before(c.createdAt));
		for (const t of pr.reviewThreads.nodes) {
			if (t.isResolved) continue; // someone closed it
			for (const c of t.comments.nodes) add(c, 'inline', c.createdAt, t.isOutdated || before(c.createdAt), t.path, t.line);
		}
		return extractFollowUps(texts);
	}

	function cacheFollowUps(key: string, value: FollowUp[]): void {
		followUpsCache.delete(key);
		if (followUpsCache.size >= FOLLOWUPS_CACHE_MAX) followUpsCache.delete(followUpsCache.keys().next().value!);
		followUpsCache.set(key, { at: Date.now(), value });
	}

	/** One query for up to FOLLOWUPS_BATCH PRs of one repo; returns one promise per PR. */
	function fetchFollowUpsBatch(host: string, owner: string, repo: string, numbers: number[]): Promise<FollowUp[]>[] {
		const all = gh.query<FollowUpsData>(host, followUpsQuery(numbers), { owner, name: repo }).then((data) => {
			if (!data.repository) throw new NotFoundError(`Repository ${owner}/${repo} not found`);
			// A missing PR fails on its own; the others in the batch still count.
			return numbers.map((n, i): FollowUp[] | Error => {
				const pr = data.repository![`p${i}`];
				if (!pr) return new NotFoundError(`Pull request #${n} not found`);
				const value = shapeFollowUps(host, owner, repo, pr);
				cacheFollowUps(prKey(host, owner, repo, n), value);
				return value;
			});
		});
		return numbers.map((_, i) =>
			all.then((list) => {
				const v = list[i]!;
				if (v instanceof Error) throw v;
				return v;
			})
		);
	}

	async function getFollowUps(targets: PrTarget[]): Promise<FollowUpsResponse> {
		const waits = new Map<string, Promise<FollowUp[]>>();
		const toFetch = new Map<string, { host: string; owner: string; repo: string; numbers: number[] }>();
		for (const t of targets) {
			const key = prKey(t.host, t.owner, t.repo, t.number);
			if (waits.has(key)) continue;
			const hit = followUpsCache.get(key);
			const r = gh.rate[t.host];
			if (hit && (Date.now() - hit.at < FOLLOWUPS_TTL_MS || (r && r.remaining < LOW_BUDGET_DETAIL))) {
				waits.set(key, Promise.resolve(hit.value));
				continue;
			}
			const pending = followUpsInflight.get(key);
			if (pending) {
				waits.set(key, pending);
				continue;
			}
			const repoKey = `${t.host}:${t.owner}/${t.repo}`;
			const group = toFetch.get(repoKey) ?? { host: t.host, owner: t.owner, repo: t.repo, numbers: [] };
			if (!group.numbers.includes(t.number)) group.numbers.push(t.number);
			toFetch.set(repoKey, group);
		}
		for (const g of toFetch.values()) {
			for (let i = 0; i < g.numbers.length; i += FOLLOWUPS_BATCH) {
				const chunk = g.numbers.slice(i, i + FOLLOWUPS_BATCH);
				fetchFollowUpsBatch(g.host, g.owner, g.repo, chunk).forEach((p, j) => {
					const key = prKey(g.host, g.owner, g.repo, chunk[j]!);
					const tracked = p.finally(() => followUpsInflight.delete(key));
					followUpsInflight.set(key, tracked);
					waits.set(key, tracked);
				});
			}
		}
		const keys = [...waits.keys()];
		const settled = await Promise.allSettled(keys.map((k) => waits.get(k)!));
		const out: FollowUpsResponse = { followUps: {}, errors: {} };
		settled.forEach((s, i) => {
			if (s.status === 'fulfilled') out.followUps[keys[i]!] = s.value;
			else out.errors[keys[i]!] = (s.reason as Error).message.slice(0, 300);
		});
		return out;
	}

	return { hostKeys, listHost, listMerged, getDetail, getDetails, prefetchDetails, cachedDetail, getFollowUps };
}
