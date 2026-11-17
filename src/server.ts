// Shepherd: a local dashboard of the team's open pull requests, plus an MCP endpoint for agents.
// Runs on Bun with no runtime dependencies. GitHub access goes through the `gh` CLI.

import { createHash, timingSafeEqual } from 'node:crypto';
import { join, normalize } from 'node:path';
import { buildClient, PUBLIC_DIR } from './build-client.ts';
import { configFeatures, DEFAULT_PORT, loadConfig, publicConfig } from './config.ts';
import { createGh } from './gh.ts';
import { createHerdr } from './herdr.ts';
import { createMcpHandler } from './mcp.ts';
import { FOLLOWUPS_MAX_PRS } from './followups.ts';
import { createPrService, NotFoundError, parsePrKey } from './prs.ts';
import { createSettingsHandler } from './settings-api.ts';
import { createConfigStore } from './settings-store.ts';
import type { DetailResponse, ErrorResponse, FollowUpsResponse, HerdrLinksResponse, LightPr, ListResponse, MergedPr, MergedResponse, PaneMatchPr } from './types.ts';

const loaded = await loadConfig();
// One object for the life of the server: a reload changes its keys in place, so `gh` and herdr keep reading it.
const config = loaded.config;
const store = createConfigStore(loaded.file, loaded.text, config);
const port = Number(process.env.PORT || config.port || DEFAULT_PORT);
// The gh runner and herdr read the hosts when they are made (a semaphore and a hostname map per host), so a change to
// the hosts makes them again. A reload that leaves the hosts as they were keeps them, with the rate budget they track.
let gh = createGh(config);
let herdr = createHerdr(config);
// The PR service and the MCP handler keep the team and repos from when they were made, so a reload makes them again.
let prs = createPrService(config, gh);
let handleMcp = createMcpHandler(config, prs, herdr);
let features = configFeatures(config);
/** The hosts as the gh runner and herdr see them: review teams are personal settings and change neither. */
const runnerHosts = (c: typeof config): string =>
	JSON.stringify(Object.entries(c.hosts).map(([k, { reviewTeams: _teams, ...h }]) => [k, h]));
store.onChange((next) => {
	const hostsBefore = runnerHosts(config);
	for (const key of Object.keys(config)) if (!(key in next)) delete (config as unknown as Record<string, unknown>)[key];
	Object.assign(config, next);
	if (runnerHosts(config) !== hostsBefore) {
		gh = createGh(config);
		herdr = createHerdr(config);
	}
	prs = createPrService(config, gh);
	handleMcp = createMcpHandler(config, prs, herdr);
	features = configFeatures(config);
	console.log('Reloaded the settings from config.json');
});

// Optional bearer token for /mcp and /api/*. It comes from the environment, not config.json,
// because config files are often readable by other users on the same machine.
const token = process.env.SHEPHERD_TOKEN?.trim() ?? '';
if (process.env.SHEPHERD_TOKEN !== undefined && !token) {
	console.error('SHEPHERD_TOKEN is set but empty. Set a value, or unset it to run without a token.');
	process.exit(1);
}
const tokenHash = createHash('sha256').update(token).digest();

function authorized(req: Request): boolean {
	if (!token) return true;
	const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
	if (!m) return false;
	// Hash both sides so the comparison is constant-time and length-independent.
	return timingSafeEqual(createHash('sha256').update(m[1]!).digest(), tokenHash);
}

// Bundle the browser client once at startup; `bun run dev` restarts on change.
const clientBundle = (await buildClient()).js;

const json = <T>(status: number, body: T) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

async function listPrs(url: URL): Promise<Response> {
	// One service for the whole call: a save while it waits makes a new one, with other hosts.
	const svc = prs;
	const runner = gh;
	const teamIds = new Set(config.team.map((m) => m.id));
	const reviewerIds = (url.searchParams.get('reviewers') ?? '')
		.split(',')
		.filter((id) => teamIds.has(id))
		.sort()
		// The cost limit on bells: each one adds a search term.
		.slice(0, config.limits?.maxBells ?? Infinity);
	const settled = await Promise.allSettled(svc.hostKeys.map((h) => svc.listHost(h, reviewerIds)));
	const list: LightPr[] = [];
	const errors: Record<string, string> = {};
	const throttled: Record<string, boolean> = {};
	settled.forEach((s, i) => {
		const host = svc.hostKeys[i]!;
		if (s.status === 'fulfilled') {
			// Send the details we already have, so the page does not ask for each row again.
			for (const pr of s.value.prs) {
				const detail = svc.cachedDetail(pr.key, pr.updatedAt);
				list.push(detail ? { ...pr, detail } : pr);
			}
			throttled[host] = s.value.throttled;
		} else {
			errors[host] = (s.reason as Error).message;
		}
	});
	// Fetch the details of the rows that lack them, in batches, and do not wait: the list answers now, and the page's /api/pr calls
	// for these rows wait for the pending batch and send no query. A failed batch is only logged, and its rows just have no detail.
	void svc.prefetchDetails(list, throttled);
	return json<ListResponse>(200, { prs: list, errors, throttled, rate: runner.rate, fetchedAt: new Date().toISOString() });
}

/** The team's merged PRs for the widest range; the page filters to the range picked, with no new request. */
async function listMerged(): Promise<Response> {
	const svc = prs;
	const settled = await Promise.allSettled(svc.hostKeys.map((h) => svc.listMerged(h)));
	const list: MergedPr[] = [];
	const errors: Record<string, string> = {};
	settled.forEach((s, i) => {
		const host = svc.hostKeys[i]!;
		if (s.status === 'rejected') errors[host] = (s.reason as Error).message;
		else {
			list.push(...s.value.prs);
			if (s.value.total > s.value.prs.length) errors[host] = `showing the newest ${s.value.prs.length} of ${s.value.total} merged PRs`;
		}
	});
	return json<MergedResponse>(200, { prs: list, errors });
}

/** Follow-ups for `?prs=<key>,<key>`, where a key is a prKey in a tracked repo. */
async function getFollowUps(url: URL): Promise<Response> {
	const keys = (url.searchParams.get('prs') ?? '').split(',').filter(Boolean);
	if (!keys.length || keys.length > FOLLOWUPS_MAX_PRS) {
		return json<ErrorResponse>(400, { error: `bad request: prs must list 1 to ${FOLLOWUPS_MAX_PRS} PR keys` });
	}
	const targets = [];
	for (const key of keys) {
		const t = parsePrKey(key);
		// Only tracked repos, so the endpoint can't be used to read arbitrary PRs through the server's gh login.
		const tracked = t && config.repos.some((r) => r.host === t.host && r.owner.toLowerCase() === t.owner.toLowerCase() && r.name.toLowerCase() === t.repo.toLowerCase());
		if (!t || !tracked) return json<ErrorResponse>(400, { error: `bad request: not a PR key in a tracked repo: ${key.slice(0, 200)}` });
		targets.push(t);
	}
	return json<FollowUpsResponse>(200, await prs.getFollowUps(targets));
}

async function getPr(url: URL): Promise<Response> {
	const q = Object.fromEntries(url.searchParams);
	const { host, owner, repo, number } = q;
	if (!host || !config.hosts[host] || !owner || !repo || !number || !/^\d+$/.test(number)) {
		return json<ErrorResponse>(400, { error: 'bad request: host, owner, repo and number are required' });
	}
	try {
		const pr = await prs.getDetail({ host, owner, repo, number, head: q.head, base: q.base, force: q.force === '1' });
		return json<DetailResponse>(200, { pr, rate: gh.rate[host] ?? null });
	} catch (e) {
		return json<ErrorResponse>(e instanceof NotFoundError ? 404 : 502, { error: (e as Error).message });
	}
}

/** Browser requests that change state must come from the dashboard itself (guards against other sites). */
function sameOrigin(req: Request): boolean {
	const origin = req.headers.get('origin');
	return !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

function isMatchPr(v: unknown): v is PaneMatchPr {
	const p = v as PaneMatchPr;
	return (
		typeof v === 'object' && v !== null &&
		typeof p.key === 'string' && typeof p.host === 'string' && typeof p.owner === 'string' && typeof p.repo === 'string' &&
		typeof p.number === 'number' && typeof p.url === 'string' && typeof p.headRefName === 'string'
	);
}

async function herdrLinks(req: Request): Promise<Response> {
	if (req.method !== 'POST' || !sameOrigin(req)) return json<ErrorResponse>(405, { error: 'POST from the dashboard only' });
	const body = (await req.json().catch(() => null)) as { prs?: unknown } | null;
	const list = Array.isArray(body?.prs) ? body.prs.filter(isMatchPr).slice(0, 500) : [];
	return json<HerdrLinksResponse>(200, await herdr.links(list));
}

async function herdrFocus(req: Request): Promise<Response> {
	if (req.method !== 'POST' || !sameOrigin(req)) return json<ErrorResponse>(405, { error: 'POST from the dashboard only' });
	const body = (await req.json().catch(() => null)) as { paneId?: unknown } | null;
	const paneId = typeof body?.paneId === 'string' && /^[\w:.-]{1,64}$/.test(body.paneId) ? body.paneId : null;
	if (!paneId) return json<ErrorResponse>(400, { error: 'paneId is required' });
	try {
		await herdr.focus(paneId);
		return json(200, { ok: true });
	} catch (e) {
		return json<ErrorResponse>(502, { error: (e as Error).message });
	}
}

const handleSettings = createSettingsHandler(store, { sameOrigin });

async function serveStatic(pathname: string): Promise<Response> {
	if (pathname === '/app.js') {
		return new Response(clientBundle, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
	}
	const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
	const file = normalize(join(PUBLIC_DIR, rel));
	if (!file.startsWith(PUBLIC_DIR)) return json<ErrorResponse>(403, { error: 'forbidden' });
	const f = Bun.file(file);
	if (!(await f.exists())) return json<ErrorResponse>(404, { error: 'not found' });
	return new Response(f, { headers: { 'cache-control': 'no-cache' } });
}

const server = Bun.serve({
	hostname: '127.0.0.1',
	port,
	idleTimeout: 120, // detail calls through the proxy can take a while
	async fetch(req) {
		const url = new URL(req.url);
		try {
			if ((url.pathname === '/mcp' || url.pathname.startsWith('/api/')) && !authorized(req)) {
				return json<ErrorResponse>(401, { error: 'unauthorized: open the #token= link the server printed at startup' });
			}
			// Pick up a config.json that changed on disk, so a hand edit applies without a restart.
			if (url.pathname === '/mcp' || url.pathname.startsWith('/api/')) await store.refresh();
			if (url.pathname === '/mcp') return await handleMcp(req);
			if (url.pathname === '/api/config') return json(200, publicConfig(config));
			if (url.pathname === '/api/prs') return await listPrs(url);
			if (url.pathname === '/api/pr') return await getPr(url);
			// A feature that config.json turns off has no endpoint, as on a server that does not have it.
			if (url.pathname === '/api/merged' && features.shipped) return await listMerged();
			if (url.pathname === '/api/followups' && features.followups) return await getFollowUps(url);
			if (url.pathname === '/api/herdr/links' && features.herdr) return await herdrLinks(req);
			if (url.pathname === '/api/herdr/focus' && features.herdr) return await herdrFocus(req);
			if (url.pathname === '/api/settings' && features.settings) return await handleSettings(req);
			if (url.pathname.startsWith('/api/')) return json<ErrorResponse>(404, { error: 'not found' });
			return await serveStatic(url.pathname);
		} catch (e) {
			console.error(e);
			return json<ErrorResponse>(500, { error: (e as Error).message });
		}
	},
});

console.log(`Shepherd dashboard: http://127.0.0.1:${server.port}${token ? `/#token=${encodeURIComponent(token)}` : ''}`);
console.log(`MCP endpoint:       http://127.0.0.1:${server.port}/mcp`);
