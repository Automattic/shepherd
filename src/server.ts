// Shepherd: a local dashboard of the team's open pull requests, plus an MCP endpoint for agents.
// Runs on Bun with no runtime dependencies. GitHub access goes through the `gh` CLI.

import { join, normalize } from 'node:path';
import { DEFAULT_PORT, loadConfig, publicConfig, ROOT } from './config.ts';
import { createGh } from './gh.ts';
import { createMcpHandler } from './mcp.ts';
import { createPrService, NotFoundError } from './prs.ts';
import type { DetailResponse, ErrorResponse, LightPr, ListResponse } from './types.ts';

const PUBLIC_DIR = join(ROOT, 'public');
const CLIENT_ENTRY = join(ROOT, 'web', 'app.ts');

const config = await loadConfig();
const port = Number(process.env.PORT || config.port || DEFAULT_PORT);
const gh = createGh(config);
const prs = createPrService(config, gh);
const handleMcp = createMcpHandler(config, prs);

// Bundle the browser client once at startup; `bun run dev` restarts on change.
const clientBundle = await (async () => {
	const result = await Bun.build({ entrypoints: [CLIENT_ENTRY], target: 'browser', sourcemap: 'inline' });
	const output = result.outputs[0];
	if (!result.success || !output) {
		console.error('Could not bundle the browser client:');
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	return output.text();
})();

const json = <T>(status: number, body: T) =>
	Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

async function listPrs(url: URL): Promise<Response> {
	const teamIds = new Set(config.team.map((m) => m.id));
	const reviewerIds = (url.searchParams.get('reviewers') ?? '')
		.split(',')
		.filter((id) => teamIds.has(id))
		.sort();
	const settled = await Promise.allSettled(prs.hostKeys.map((h) => prs.listHost(h, reviewerIds)));
	const list: LightPr[] = [];
	const errors: Record<string, string> = {};
	const throttled: Record<string, boolean> = {};
	settled.forEach((s, i) => {
		const host = prs.hostKeys[i]!;
		if (s.status === 'fulfilled') {
			list.push(...s.value.prs);
			throttled[host] = s.value.throttled;
		} else {
			errors[host] = (s.reason as Error).message;
		}
	});
	return json<ListResponse>(200, { prs: list, errors, throttled, rate: gh.rate, fetchedAt: new Date().toISOString() });
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
			if (url.pathname === '/mcp') return await handleMcp(req);
			if (url.pathname === '/api/config') return json(200, publicConfig(config));
			if (url.pathname === '/api/prs') return await listPrs(url);
			if (url.pathname === '/api/pr') return await getPr(url);
			if (url.pathname.startsWith('/api/')) return json<ErrorResponse>(404, { error: 'not found' });
			return await serveStatic(url.pathname);
		} catch (e) {
			console.error(e);
			return json<ErrorResponse>(500, { error: (e as Error).message });
		}
	},
});

console.log(`Shepherd dashboard: http://127.0.0.1:${server.port}`);
console.log(`MCP endpoint:       http://127.0.0.1:${server.port}/mcp`);
