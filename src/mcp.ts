// MCP (Model Context Protocol) endpoint for the Shepherd dashboard.
// Streamable HTTP transport, stateless: POST /mcp with JSON-RPC, answered with application/json.
// It reuses the dashboard's gh runner and caches, so agents and the page share one budget.

import { baseAgeHours, baseTooOld } from './base-age.ts';
import type { HerdrService } from './herdr.ts';
import type { PrService } from './prs.ts';
import type { Config, LightPr, PrDetail, RepoConfig, TeamMember } from './types.ts';
import { changesRequestedPending, waitReasons, type WaitReason } from './waiting.ts';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DETAIL_MAX_AGE_MS = 60_000; // agents get data at most a minute old
const DORMANT_MS = 60 * 24 * 3600 * 1000;
const MAX_BODY_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// JSON-RPC types

type JsonRpcId = string | number;

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: JsonRpcId | null;
	method: string;
	params?: Record<string, unknown>;
}

type JsonRpcResponse =
	| { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
	| { jsonrpc: '2.0'; id: JsonRpcId | null; error: { code: number; message: string } };

type Args = Record<string, unknown>;

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: { readOnlyHint: boolean; openWorldHint: boolean };
	run(args: Args): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Argument readers: tool arguments come from agents and are untrusted.

function str(args: Args, name: string): string | undefined {
	const v = args[name];
	if (v === undefined || v === null || v === '') return undefined;
	if (typeof v !== 'string') throw new Error(`\`${name}\` must be a string`);
	return v;
}

function bool(args: Args, name: string): boolean | undefined {
	const v = args[name];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== 'boolean') throw new Error(`\`${name}\` must be true or false`);
	return v;
}

function int(args: Args, name: string): number | undefined {
	const v = args[name];
	if (v === undefined || v === null || v === '') return undefined;
	const n = typeof v === 'string' ? Number(v) : v;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new Error(`\`${name}\` must be a positive integer`);
	return n;
}

function isRequest(msg: unknown): msg is JsonRpcRequest {
	return typeof msg === 'object' && msg !== null && (msg as JsonRpcRequest).jsonrpc === '2.0' && typeof (msg as JsonRpcRequest).method === 'string';
}

// ---------------------------------------------------------------------------

export function createMcpHandler(config: Config, prs: PrService, herdr: HerdrService): (req: Request) => Promise<Response> {
	const team = config.team;
	const me = team.find((m) => m.id === config.me)!; // loadConfig guarantees it

	// ---- lookups ----

	function findMember(who: string): TeamMember | null {
		const w = who.trim().toLowerCase().replace(/^@/, '');
		if (['me', 'self', 'i', 'you'].includes(w)) return me;
		return (
			team.find((m) => [m.id, m.short, m.name, ...Object.values(m.logins)].some((v) => v.toLowerCase() === w)) ??
			team.find((m) => m.name.toLowerCase().split(/\s+/).includes(w)) ??
			null
		);
	}

	function requireMember(who: string): TeamMember {
		const m = findMember(who);
		if (!m) throw new Error(`Unknown person "${who}". Known: ${team.map((t) => `${t.id} (${t.name})`).join(', ')}`);
		return m;
	}

	function findRepo(repo: string): RepoConfig {
		const r = repo.trim().toLowerCase().replace(/^https?:\/\/[^/]+\//, '');
		const hit = config.repos.find((x) => [x.short, x.name, `${x.owner}/${x.name}`].some((v) => v.toLowerCase() === r));
		if (!hit) {
			throw new Error(`Unknown repo "${repo}". Known: ${config.repos.map((x) => `${x.short} (${x.owner}/${x.name})`).join(', ')}`);
		}
		return hit;
	}

	function parsePrUrl(url: string): { host: string; owner: string; repo: string; number: number } | null {
		const m = url.match(/https?:\/\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
		if (!m) return null;
		const host = Object.entries(config.hosts).find(([, h]) => h.hostname === m[1])?.[0];
		return host ? { host, owner: m[2]!, repo: m[3]!, number: Number(m[4]) } : null;
	}

	const nameOf = (login: string): string => {
		const m = team.find((t) => Object.values(t.logins).includes(login));
		return m ? `${m.short === 'You' ? m.name : m.short} (${login})` : login;
	};
	const repoShort = (host: string, owner: string, name: string): string =>
		config.repos.find((r) => r.host === host && r.owner === owner && r.name === name)?.short ?? name;
	const linearUrl = (key: string) => (config.linear ? `https://linear.app/${config.linear.workspace}/issue/${key}` : null);
	const reviewLabel = config.aiReviewLabel || 'AI review';
	const exampleMember = team.find((m) => m.id !== config.me)?.id ?? me.id;
	const exampleRepos = config.repos.slice(0, 2).map((r) => `"${r.short}"`).join(', ');
	const hostname = (hostKey: string) => config.hosts[hostKey]?.hostname ?? hostKey;

	// ---- shaping ----

	function summarize(d: PrDetail, { findings = false } = {}) {
		const baseHours = baseAgeHours(d.baseAge);
		return {
			ref: `${repoShort(d.host, d.owner, d.repo)}#${d.number}`,
			repo: `${d.owner}/${d.repo}`,
			host: hostname(d.host),
			number: d.number,
			url: d.url,
			title: d.title,
			state: d.state,
			draft: d.isDraft,
			author: nameOf(d.author.login),
			created: d.createdAt,
			updated: d.updatedAt,
			branch: `${d.headRefName} -> ${d.baseRefName}`,
			linear: d.linear.map((key) => ({ key, url: linearUrl(key) })),
			stackedOn: d.parent ? { number: d.parent.number, url: d.parent.url, title: d.parent.title } : null,
			stackedOnThis: d.stackedOnThis.map((p) => ({ number: p.number, url: p.url, title: p.title })),
			waitingOnReviewFrom: {
				people: d.requested.users.map((u) => nameOf(u.login)),
				teams: d.requested.teams.map((t) => t.slug),
				// The requested teams that are in the host's reviewTeams, as "org/team" to match the team tool and config.
				reviewTeams: d.requested.teams.filter((t) => t.reviewTeam).map((t) => t.combinedSlug),
			},
			// A review team is requested on an open, non-draft PR: it waits on the team, as the review queue counts it.
			reviewTeamRequested: d.state === 'OPEN' && !d.isDraft && d.requested.teams.some((t) => t.reviewTeam),
			approvedBy: d.reviews.filter((r) => r.state === 'APPROVED').map((r) => nameOf(r.login)),
			changesRequestedBy: d.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => nameOf(r.login)),
			reviewDecision: d.reviewDecision,
			waitingOnAuthor: changesRequestedPending(d),
			aiReview: d.bot
				? { bot: d.bot.login, unresolved: d.bot.open, fix: d.bot.blocking, minor: d.bot.open - d.bot.blocking, onOutdatedCode: d.bot.outdated }
				: null,
			participants: d.participants.map((p) => ({ who: nameOf(p.login), lastActive: p.lastActive })),
			lastActivity: d.lastActivity
				? {
						who: nameOf(d.lastActivity.login),
						at: d.lastActivity.at,
						kind: d.lastActivity.kind,
						isAuthor: d.lastActivity.login === d.author.login,
						isMe: Object.values(me.logins).includes(d.lastActivity.login),
					}
				: null,
			checks: d.checks,
			mergeConflicts: d.mergeable === 'CONFLICTING',
			// Hours since the commit this PR branched from; null when merged, closed or unknown (not fresh).
			baseAgeHours: baseHours === null ? null : Math.round(baseHours * 10) / 10,
			...(d.baseAge?.limitHours != null ? { baseTooOld: baseTooOld(d.baseAge) } : {}),
			...(d.baseAge ? { baseBehindBy: d.baseAge.behindBy } : {}),
			...(d.baseAge?.error ? { baseAgeError: d.baseAge.error } : {}),
			size: d.size,
			relatedPrs: d.refs.map((r) => r.url),
			...(findings && d.bot
				? {
						aiReviewFindings: d.bot.findings.map((f) => ({
							title: f.title,
							severity: f.severity,
							kind: f.kind,
							category: f.category,
							outdated: f.outdated,
							file: f.path ? `${f.path}${f.line ? `:${f.line}` : ''}` : null,
							url: f.url,
						})),
					}
				: {}),
		};
	}
	type Summary = ReturnType<typeof summarize>;

	function lightSummary(p: LightPr, error: string) {
		return {
			ref: `${repoShort(p.host, p.owner, p.repo)}#${p.number}`,
			url: p.url,
			title: p.title,
			author: nameOf(p.author.login),
			updated: p.updatedAt,
			error: `details unavailable: ${error}`,
		};
	}

	async function details(list: LightPr[]): Promise<(Summary | ReturnType<typeof lightSummary>)[]> {
		const settled = await Promise.allSettled(
			list.map((p) =>
				prs.getDetail({
					host: p.host,
					owner: p.owner,
					repo: p.repo,
					number: p.number,
					head: p.headRefName,
					base: p.baseRefName,
					maxAgeMs: DETAIL_MAX_AGE_MS,
				})
			)
		);
		return settled.map((s, i) =>
			s.status === 'fulfilled' ? summarize(s.value) : lightSummary(list[i]!, (s.reason as Error).message)
		);
	}

	async function collect(reviewers: string[] = []): Promise<{ prs: LightPr[]; errors: string[] }> {
		const settled = await Promise.allSettled(prs.hostKeys.map((h) => prs.listHost(h, reviewers)));
		const out: LightPr[] = [];
		const errors: string[] = [];
		settled.forEach((s, i) => {
			if (s.status === 'fulfilled') out.push(...s.value.prs);
			else errors.push(`${hostname(prs.hostKeys[i]!)}: ${(s.reason as Error).message}`);
		});
		return { prs: out, errors };
	}

	const hasFindings = (x: Summary | ReturnType<typeof lightSummary>): boolean =>
		'aiReview' in x && x.aiReview !== null && x.aiReview.unresolved > 0;

	// ---- tools ----

	const hostsWithReviewTeams = Object.values(config.hosts).filter((h) => h.reviewTeams?.length);
	const reviewTeamsByHost = hostsWithReviewTeams.length
		? Object.fromEntries(hostsWithReviewTeams.map((h) => [h.hostname, h.reviewTeams]))
		: null;
	const reviewTeamRequested = (x: Summary | ReturnType<typeof lightSummary>): boolean =>
		'reviewTeamRequested' in x && x.reviewTeamRequested;

	const tools: Tool[] = [
		{
			name: 'team',
			title: 'Team and repos',
			description: 'List the people on the team (with their login on each GitHub host), who "me" is, and the repos the dashboard tracks.',
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			annotations: { readOnlyHint: true, openWorldHint: false },
			run: async () => ({
				me: me.id,
				team: team.map((m) => ({
					id: m.id,
					name: m.name,
					logins: Object.fromEntries(Object.entries(m.logins).map(([host, login]) => [hostname(host), login])),
				})),
				repos: config.repos.map((r) => ({ short: r.short, repo: `${r.owner}/${r.name}`, host: hostname(r.host) })),
				aiReview: { label: reviewLabel, bots: Object.fromEntries(Object.values(config.hosts).filter((h) => h.bot).map((h) => [h.hostname, h.bot])) },
				linear: config.linear ? `https://linear.app/${config.linear.workspace}` : null,
				// GitHub teams per host whose review requests put a PR in the team's queue; null when none are set.
				reviewTeams: reviewTeamsByHost,
			}),
		},
		{
			name: 'list_prs',
			title: 'List open team pull requests',
			description:
				'List open pull requests written by the team in the tracked repos. Each result says whose review it waits on (and whether one of the configured review teams is requested), who approved, how many AI-review bot threads are unresolved, who has participated (most recently active first), any Linear tickets, and any stacked parent PR. Filter by author, repo, requested reviewer, or review-team request.',
			inputSchema: {
				type: 'object',
				properties: {
					author: { type: 'string', description: `Only PRs by this person: team id, first name or GitHub login (e.g. "me", "${exampleMember}").` },
					repo: { type: 'string', description: `Only this repo: short name or owner/name (e.g. ${exampleRepos}).` },
					waiting_on: { type: 'string', description: "Only PRs that directly request this person's review. Includes PRs by people outside the team." },
					include_drafts: { type: 'boolean', default: true },
					include_dormant: {
						type: 'boolean',
						default: false,
						description: 'Include PRs idle for more than 60 days. PRs that request a review team are always included.',
					},
					has_ai_review_findings: { type: 'boolean', description: `Only PRs with unresolved ${reviewLabel} threads.` },
					review_team_requested: {
						type: 'boolean',
						description:
							"Only open, non-draft PRs that request a review from one of the hosts' reviewTeams (see the team tool), including PRs by people outside the team. Use it to find PRs that are ready for review.",
					},
					limit: { type: 'integer', default: 60, minimum: 1, maximum: 200 },
				},
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
			run: async (args) => {
				const authorArg = str(args, 'author');
				const repoArg = str(args, 'repo');
				const waitingArg = str(args, 'waiting_on');
				const author = authorArg ? requireMember(authorArg) : null;
				const repo = repoArg ? findRepo(repoArg) : null;
				const reviewer = waitingArg ? requireMember(waitingArg) : null;
				const includeDrafts = bool(args, 'include_drafts') ?? true;
				const includeDormant = bool(args, 'include_dormant') ?? false;
				const onlyFindings = bool(args, 'has_ai_review_findings') ?? false;
				const onlyTeam = bool(args, 'review_team_requested') ?? false;
				const limit = Math.min(int(args, 'limit') ?? 60, 200);
				if (onlyTeam && !reviewTeamsByHost) {
					throw new Error('No host lists reviewTeams in config.json, so no PR can request one.');
				}

				const { prs: all, errors } = await collect(reviewer ? [reviewer.id] : []);
				let picked = all.filter((p) => {
					if (reviewer && !p.requestedFor.includes(reviewer.id)) return false;
					// The review-team search also finds PRs by people outside the team; keep those for this filter.
					if (onlyTeam && !p.teamRequested) return false;
					if (!reviewer && !p.authoredByTeam && !onlyTeam) return false;
					if (author && author.logins[p.host] !== p.author.login) return false;
					if (repo && !(p.host === repo.host && p.owner === repo.owner && p.repo === repo.name)) return false;
					if (!includeDrafts && p.isDraft) return false;
					// A PR that requests a review team waits on the team, so it stays even when idle, like a direct request.
					const dormant = Date.now() - new Date(p.updatedAt).getTime() > DORMANT_MS;
					if (!includeDormant && dormant && !reviewer && !p.teamRequested) return false;
					return true;
				});
				picked.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
				const matchedBeforeDetails = picked.length;
				// These filters need details (the team request may have been cleared since the search), so apply the limit only after them.
				const needsDetails = onlyFindings || onlyTeam;
				if (!needsDetails) picked = picked.slice(0, limit);
				let items = await details(picked);
				if (needsDetails) {
					// A PR whose details failed can't be checked against these filters; report it instead of dropping it silently.
					for (const x of items) if ('error' in x) errors.push(`${x.url}: ${x.error}`);
					items = items.filter((x) => !('error' in x));
				}
				if (onlyFindings) items = items.filter(hasFindings);
				if (onlyTeam) items = items.filter(reviewTeamRequested);
				const matched = needsDetails ? items.length : matchedBeforeDetails;
				items = items.slice(0, limit);
				return { count: items.length, matchedBeforeLimit: matched, errors, pullRequests: items };
			},
		},
		{
			name: 'review_queue',
			title: 'Review queue for a person',
			description:
				`Open PRs in the tracked repos that are waiting on one person (default: "me", the dashboard owner), with the reason for each: "requested" (their review is directly requested), "team" (a review team they belong to is requested; never on their own PRs, drafts or PRs they approved), "turn" (someone else had the last word on a PR they wrote or took part in, and they have not already approved it), or "author" (they wrote it, changes were requested, and nothing was pushed since). Use it to answer "what is waiting on me?" or "on ${exampleMember}?". PRs idle for more than 60 days are left out unless their review, or a review team's, is requested.`,
			inputSchema: {
				type: 'object',
				properties: { person: { type: 'string', default: 'me', description: 'Team id, first name or GitHub login.' } },
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
			run: async (args) => {
				const person = requireMember(str(args, 'person') ?? 'me');
				const { prs: all, errors } = await collect([person.id]);
				// Every non-dormant candidate needs details: "turn" and "author" depend on activity, not just requests.
				const candidates = all.filter(
					(p) => p.requestedFor.includes(person.id) || p.teamRequested || Date.now() - new Date(p.updatedAt).getTime() <= DORMANT_MS
				);
				const settled = await Promise.allSettled(
					candidates.map((p) =>
						prs.getDetail({ host: p.host, owner: p.owner, repo: p.repo, number: p.number, head: p.headRefName, base: p.baseRefName, maxAgeMs: DETAIL_MAX_AGE_MS })
					)
				);
				const waiting: (Summary & { waitingBecause: WaitReason[] })[] = [];
				settled.forEach((s, i) => {
					if (s.status === 'rejected') {
						errors.push(`${candidates[i]!.url}: ${(s.reason as Error).message}`);
						return;
					}
					const reasons = waitReasons(s.value, person);
					if (reasons.length) waiting.push({ ...summarize(s.value), waitingBecause: reasons });
				});
				waiting.sort((a, b) => b.updated.localeCompare(a.updated));
				return { person: person.name, count: waiting.length, errors, pullRequests: waiting };
			},
		},
		{
			name: 'get_pr',
			title: 'Pull request details',
			description:
				'Full status of one pull request: reviewers waiting, approvals, every unresolved AI-review bot finding (severity, file, link), participants and when each was last active (who to ping), the most recent activity (who acted last, and whether it was the author or "me"), checks, conflicts, how old the base is (baseAgeHours, and baseTooOld when the repo sets maxBaseAgeHours), Linear tickets, stacked PRs, and any local herdr terminal panes working on it. Give a PR URL, or a repo plus number.',
			inputSchema: {
				type: 'object',
				properties: {
					url: { type: 'string', description: `PR URL on a configured host (${Object.values(config.hosts).map((h) => h.hostname).join(', ')}).` },
					repo: { type: 'string', description: 'Short name or owner/name, used with number.' },
					number: { type: 'integer' },
				},
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
			run: async (args) => {
				const url = str(args, 'url');
				let target = url ? parsePrUrl(url) : null;
				if (url && !target) throw new Error(`Not a pull request URL on a configured host: ${url}`);
				if (!target) {
					const repoArg = str(args, 'repo');
					const number = int(args, 'number');
					if (!repoArg || !number) throw new Error('Give a url, or both repo and number.');
					const r = findRepo(repoArg);
					target = { host: r.host, owner: r.owner, repo: r.name, number };
				}
				const d = await prs.getDetail({ ...target, maxAgeMs: DETAIL_MAX_AGE_MS });
				// Panes in the local herdr session working on this PR (only when herdr is installed and running).
				// Match against every tracked PR, as the dashboard does, so a session that surveys many PRs
				// isn't mistaken for one working on this PR.
				const { prs: tracked } = await collect([]);
				const matchList = tracked
					.filter((p) => p.key !== d.key)
					.map((p) => ({ key: p.key, host: p.host, owner: p.owner, repo: p.repo, number: p.number, url: p.url, headRefName: p.headRefName }));
				matchList.push({ key: d.key, host: d.host, owner: d.owner, repo: d.repo, number: d.number, url: d.url, headRefName: d.headRefName });
				const h = await herdr.links(matchList);
				const herdrPanes = h.available
					? (h.links[d.key] ?? []).map((p) => ({
							paneId: p.paneId,
							where: [p.workspaceLabel, p.tabLabel].filter(Boolean).join(' / ') || p.workspaceId,
							title: p.title,
							agent: p.agent,
							agentStatus: p.agentStatus,
							linkedBy: p.signals,
							git: p.git,
						}))
					: { unavailable: h.reason };
				return { ...summarize(d, { findings: true }), herdrPanes };
			},
		},
	];
	const toolByName = new Map(tools.map((t) => [t.name, t]));

	// ---- JSON-RPC dispatch ----

	async function dispatch(msg: unknown): Promise<JsonRpcResponse | null> {
		if (!isRequest(msg)) {
			const id = typeof msg === 'object' && msg !== null ? ((msg as { id?: JsonRpcId }).id ?? null) : null;
			return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } };
		}
		const { id, method, params = {} } = msg;
		const isNotification = id === undefined || id === null;
		const ok = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
		const fail = (code: number, message: string): JsonRpcResponse | null =>
			isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } };

		switch (method) {
			case 'initialize': {
				const requested = params.protocolVersion;
				const version = PROTOCOL_VERSIONS.find((v) => v === requested) ?? PROTOCOL_VERSIONS[0];
				return ok({
					protocolVersion: version,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'shepherd', title: 'Shepherd PR dashboard', version: '0.3.0' },
					instructions:
						"Read-only view of the team's open pull requests. Use review_queue for what waits on someone's review, list_prs for the team's PRs, get_pr for one PR's AI-review findings and who to ping, team for the roster.",
				});
			}
			case 'ping':
				return ok({});
			case 'tools/list':
				return ok({
					tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
				});
			case 'tools/call': {
				const tool = typeof params.name === 'string' ? toolByName.get(params.name) : undefined;
				if (!tool) return fail(-32602, `Unknown tool: ${String(params.name)}`);
				const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Args) : {};
				try {
					const result = await tool.run(args);
					return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] });
				} catch (e) {
					return ok({ content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true });
				}
			}
			case 'resources/list':
				return ok({ resources: [] });
			case 'prompts/list':
				return ok({ prompts: [] });
			default:
				if (method.startsWith('notifications/')) return null;
				return fail(-32601, `Method not found: ${method}`);
		}
	}

	const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
		Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

	return async function handleMcp(req: Request): Promise<Response> {
		// Guard against DNS rebinding: only local pages (or non-browser clients) may call.
		const origin = req.headers.get('origin');
		if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) {
			return json(403, { error: 'forbidden origin' });
		}
		if (req.method !== 'POST') return json(405, { error: 'This MCP server is stateless; use POST.' }, { allow: 'POST' });

		const raw = await req.text();
		if (raw.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
		let body: unknown;
		try {
			body = JSON.parse(raw);
		} catch {
			return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		}
		const batch = Array.isArray(body);
		const replies = (await Promise.all((batch ? (body as unknown[]) : [body]).map(dispatch))).filter(
			(r): r is JsonRpcResponse => r !== null
		);
		if (!replies.length) return new Response(null, { status: 202 });
		return json(200, batch ? replies : replies[0]);
	};
}
