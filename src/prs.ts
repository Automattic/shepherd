// Pull request data: the light list search and the full per-PR detail, with caching.

import type { GhRunner } from './gh.ts';
import {
	SEVERITIES,
	type BotFinding,
	type BotSummary,
	type Config,
	type LightPr,
	type LastActivity,
	type MiniPr,
	type Participant,
	type PrDetail,
	type PrRef,
	type PrReview,
	type Severity,
	type TeamMember,
} from './types.ts';

const DEFAULT_BRANCHES = new Set(['trunk', 'main', 'master', 'develop']);
const LIST_TTL_MS = 2_000;
const DETAIL_TTL_MS = 3_000;
const FORCED_DETAIL_TTL_MS = 1_000;
const LOW_BUDGET_LIST = 300; // below this, reuse the last list for up to 5 minutes
const LOW_BUDGET_DETAIL = 150; // below this, serve cached details

// ---------------------------------------------------------------------------
// Raw GraphQL shapes

interface RawAuthor {
	login: string;
	name?: string | null;
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
	author: RawAuthor | null;
	repository: { name: string; owner: { login: string } };
}

interface SearchData {
	search: {
		issueCount: number;
		pageInfo: { hasNextPage: boolean; endCursor: string | null };
		nodes: (RawLightPr | Record<string, never> | null)[];
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
				| { __typename: 'Team'; slug: string; name: string }
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
		pullRequest: RawDetailPr | null;
		parent?: { nodes: RawMiniPr[] };
		stackedOnThis: { nodes: RawMiniPr[] };
	} | null;
}

interface RefsData {
	repository: { pullRequest: { headRefName: string; baseRefName: string } | null } | null;
}

// ---------------------------------------------------------------------------
// Queries

const LIGHT_FIELDS = `
	... on PullRequest {
		number title url isDraft updatedAt createdAt headRefName baseRefName
		author { login ... on User { name } }
		repository { name owner { login } }
	}`;

const SEARCH_QUERY = `query($q:String!, $after:String) {
	rateLimit { remaining limit resetAt cost }
	search(query:$q, type:ISSUE, first:100, after:$after) {
		issueCount pageInfo { hasNextPage endCursor }
		nodes { ${LIGHT_FIELDS} }
	}
}`;

const DETAIL_QUERY = `query($owner:String!, $name:String!, $n:Int!, $head:String!, $base:String!, $withParent:Boolean!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		pullRequest(number:$n) {
			number title url state merged mergedAt isDraft updatedAt createdAt
			headRefName baseRefName body mergeable reviewDecision additions deletions changedFiles
			author { login ... on User { name } }
			statusCheckRollup { state }
			reviewRequests(first:30) { nodes { requestedReviewer {
				__typename
				... on User { login name }
				... on Team { slug name }
			} } }
			latestOpinionatedReviews(first:30) { nodes { state submittedAt author { login } } }
			participants(first:50) { totalCount nodes { login name } }
			comments(last:50) { nodes { author { login } createdAt } }
			reviews(last:50) { nodes { author { login } submittedAt } }
			commits(last:50) { nodes { commit { committedDate author { user { login } } } } }
			reviewThreads(first:100) { nodes {
				isResolved isOutdated path line
				comments(first:1) { nodes { author { login } body url createdAt } }
			} }
		}
		parent: pullRequests(headRefName:$base, first:1, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}) @include(if:$withParent) {
			nodes { number title url author { login } }
		}
		stackedOnThis: pullRequests(baseRefName:$head, first:10, states:[OPEN]) {
			nodes { number title url author { login } }
		}
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
	if (keys.length) {
		const keyRe = new RegExp(`\\b(${keys.join('|')})-(\\d+)\\b`, 'gi');
		for (const m of text.matchAll(keyRe)) found.add(`${m[1]!.toUpperCase()}-${m[2]}`);
	}
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

export interface PrService {
	readonly hostKeys: string[];
	listHost(hostKey: string, reviewerIds: string[]): Promise<{ prs: LightPr[]; throttled: boolean }>;
	getDetail(req: DetailRequest): Promise<PrDetail>;
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

	const botLogins = new Set(
		[...Object.values(config.hosts).map((h) => h.bot), ...(config.ignoreParticipants ?? [])]
			.filter((l): l is string => Boolean(l))
			.map((l) => l.toLowerCase())
	);
	const isBot = (login: string | undefined): boolean =>
		!login || botLogins.has(login.toLowerCase()) || /\[bot\]$|-bot$|^app\//i.test(login);

	// ---- list ----

	const listCache = new Map<string, { at: number; prs: LightPr[] }>();

	async function searchAll(hostKey: string, q: string): Promise<RawLightPr[]> {
		const nodes: RawLightPr[] = [];
		let after: string | null = null;
		for (let page = 0; page < 5; page++) {
			const data: SearchData = await gh.query<SearchData>(hostKey, SEARCH_QUERY, { q, after });
			for (const n of data.search.nodes) if (n && 'number' in n) nodes.push(n as RawLightPr);
			if (!data.search.pageInfo.hasNextPage) break;
			after = data.search.pageInfo.endCursor;
		}
		return nodes;
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
			author: { login: n.author?.login ?? 'ghost', name: n.author?.name ?? null },
			authoredByTeam: false,
			requestedFor: [],
		};
	}

	async function listHost(hostKey: string, reviewerIds: string[]) {
		const cacheKey = `${hostKey}|${reviewerIds.join(',')}`;
		const cached = listCache.get(cacheKey);
		const r = gh.rate[hostKey];
		if (cached && r && r.remaining < LOW_BUDGET_LIST && Date.now() - cached.at < 5 * 60_000) {
			return { prs: cached.prs, throttled: true };
		}
		if (cached && Date.now() - cached.at < LIST_TTL_MS) return { prs: cached.prs, throttled: false };

		const repos = config.repos
			.filter((x) => x.host === hostKey)
			.map((x) => `repo:${x.owner}/${x.name}`)
			.join(' ');
		const authors = config.team
			.map((m) => loginFor(m, hostKey))
			.filter((l): l is string => Boolean(l))
			.map((l) => `author:${l}`)
			.join(' ');
		const searches: { kind: 'team' | 'review'; id?: string; q: string }[] = [];
		if (authors) searches.push({ kind: 'team', q: `is:pr is:open ${repos} ${authors}` });
		for (const id of reviewerIds) {
			const login = loginFor(teamById.get(id), hostKey);
			if (login) searches.push({ kind: 'review', id, q: `is:pr is:open ${repos} user-review-requested:${login}` });
		}

		const results = await Promise.all(searches.map((s) => searchAll(hostKey, s.q)));
		const byKey = new Map<string, LightPr>();
		searches.forEach((s, i) => {
			for (const node of results[i] ?? []) {
				const pr = lightPr(hostKey, node);
				const existing = byKey.get(pr.key) ?? pr;
				if (s.kind === 'team') existing.authoredByTeam = true;
				else if (s.id) existing.requestedFor.push(s.id);
				byKey.set(pr.key, existing);
			}
		});
		const prs = [...byKey.values()];
		listCache.set(cacheKey, { at: Date.now(), prs });
		return { prs, throttled: false };
	}

	// ---- detail ----

	const detailCache = new Map<string, { at: number; value: PrDetail }>();
	const inflight = new Map<string, Promise<PrDetail>>();

	function shapeBot(hostKey: string, pr: RawDetailPr): BotSummary | null {
		const bot = config.hosts[hostKey]?.bot;
		if (!bot) return null;
		const findings: BotFinding[] = [];
		for (const t of pr.reviewThreads.nodes) {
			const first = t.comments.nodes[0];
			if (!first || first.author?.login !== bot || t.isResolved) continue;
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
		const touch = (login: string | undefined, at: string | null | undefined, kind: LastActivity['kind']) => {
			if (!login || !at) return;
			const prev = lastActive.get(login);
			if (!prev || prev < at) lastActive.set(login, at);
			if (!isBot(login) && (!lastActivity || lastActivity.at < at)) lastActivity = { login, at, kind };
		};
		for (const c of pr.comments.nodes) touch(c.author?.login, c.createdAt, 'comment');
		for (const r of pr.reviews.nodes) touch(r.author?.login, r.submittedAt, 'review');
		for (const t of pr.reviewThreads.nodes) touch(t.comments.nodes[0]?.author?.login, t.comments.nodes[0]?.createdAt, 'review');
		for (const c of pr.commits.nodes) touch(c.commit.author?.user?.login, c.commit.committedDate, 'commit');
		// Participation means a comment, a review or a commit; mentions and review requests alone don't count.
		const authorLogin = pr.author?.login;
		const nameByLogin = new Map(pr.participants.nodes.map((p) => [p.login, p.name]));
		const participants = [...lastActive.entries()]
			.filter(([login]) => login !== authorLogin && !isBot(login))
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
		for (const n of pr.reviewRequests.nodes) {
			const r = n.requestedReviewer;
			if (r && r.__typename === 'User' && 'login' in r) users.push({ login: r.login, name: r.name });
			else if (r && r.__typename === 'Team' && 'slug' in r) teams.push({ slug: r.slug, name: r.name });
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
			bot: shapeBot(hostKey, pr),
			participants,
			authorLastActive: (pr.author && lastActive.get(pr.author.login)) ?? null,
			lastActivity,
			lastCommitAt: pr.commits.nodes.map((c) => c.commit.committedDate).sort().at(-1) ?? null,
			linear: [...linear],
			refs: refs.filter((r) => r.key !== key),
			hashRefs: hashRefs.filter((n) => n !== pr.number),
			parent: parent ? mini(parent) : null,
			stackedOnThis: data.repository.stackedOnThis.nodes.map(mini),
			fetchedAt: new Date().toISOString(),
		};
	}

	async function getDetail(req: DetailRequest): Promise<PrDetail> {
		const { host, owner, repo } = req;
		const number = Number(req.number);
		const key = prKey(host, owner, repo, number);
		const cached = detailCache.get(key);
		const r = gh.rate[host];
		if (cached && r && r.remaining < LOW_BUDGET_DETAIL) return { ...cached.value, throttled: true };
		const ttl = req.maxAgeMs ?? (req.force ? FORCED_DETAIL_TTL_MS : DETAIL_TTL_MS);
		if (cached && Date.now() - cached.at < ttl) return cached.value;
		const pending = inflight.get(key);
		if (pending) return pending;

		const p = (async () => {
			// Callers that only know the number (e.g. MCP agents) get the branches looked up first,
			// so the stacked-parent lookup still works.
			let head = req.head || cached?.value.headRefName;
			let base = req.base || cached?.value.baseRefName;
			if (!head || !base) {
				const refs = await gh.query<RefsData>(host, REFS_QUERY, { owner, name: repo, n: number });
				const pr = refs.repository?.pullRequest;
				if (!pr) throw new NotFoundError('Pull request not found');
				head = pr.headRefName;
				base = pr.baseRefName;
			}
			const data = await gh.query<DetailData>(host, DETAIL_QUERY, {
				owner,
				name: repo,
				n: number,
				head,
				base,
				withParent: !DEFAULT_BRANCHES.has(base),
			});
			const value = shapeDetail(host, owner, repo, data);
			if (!value) throw new NotFoundError('Pull request not found');
			detailCache.set(key, { at: Date.now(), value });
			return value;
		})().finally(() => inflight.delete(key));
		inflight.set(key, p);
		return p;
	}

	return { hostKeys, listHost, getDetail };
}
