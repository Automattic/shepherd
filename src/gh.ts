// Runs GraphQL queries and REST GETs through the `gh` CLI, which owns authentication.
// Hosts with a `proxychains` config (e.g. a GitHub Enterprise behind a SOCKS proxy) go through it.

import { expandHome } from './config.ts';
import type { Config, RateLimit } from './types.ts';

const TIMEOUT_MS = 45_000;

/** Caps how many `gh` processes run at once for one host. */
export class Semaphore {
	#active = 0;
	#queue: (() => void)[] = [];

	constructor(private readonly limit: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.#active >= this.limit) await new Promise<void>((resolve) => this.#queue.push(resolve));
		this.#active++;
		try {
			return await fn();
		} finally {
			this.#active--;
			this.#queue.shift()?.();
		}
	}
}

interface GraphQLResponse<T> {
	data?: T & { rateLimit?: Omit<RateLimit, 'at'> | null };
	errors?: { message: string }[];
}

export interface GhRunner {
	/** Runs one GraphQL query. Resolves with the data even when GitHub also reports partial errors. */
	query<T>(hostKey: string, query: string, variables?: Record<string, unknown>): Promise<T>;
	/** Runs one REST GET, e.g. `repos/o/r/compare/a...b`. Rejects on any HTTP error. */
	get<T>(hostKey: string, path: string): Promise<T>;
	/** The latest GraphQL budget seen per host (GitHub Enterprise servers often report none). */
	readonly rate: Record<string, RateLimit>;
}

/**
 * The environment of a `gh` call for one host name. An inherited GH_HOST could send the call to another host, so it goes.
 * gh sends GH_TOKEN and GITHUB_TOKEN to github.com and also to `github.localhost` and `*.ghe.com` (over plain HTTP for
 * github.localhost), so those tokens go only to github.com. A host that the settings panel adds can then never receive them.
 * Other hosts use gh's stored login for that host, or GH_ENTERPRISE_TOKEN (the panel locks host names when that is set).
 */
export function ghEnv(hostname: string, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...base, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' };
	delete env.GH_HOST;
	delete env.GH_ENTERPRISE_TOKEN_HOST;
	if (hostname.toLowerCase() !== 'github.com') {
		delete env.GH_TOKEN;
		delete env.GITHUB_TOKEN;
	}
	return env;
}

export function createGh(config: Config): GhRunner {
	const rate: Record<string, RateLimit> = {};
	const semaphores = new Map(
		Object.entries(config.hosts).map(([k, h]) => [k, new Semaphore(h.concurrency ?? 4)] as const)
	);

	/** Runs `gh api <args>` for a host and returns stdout, stderr and the exit code. */
	async function spawnGh(hostKey: string, args: string[], stdin?: string): Promise<{ out: string; err: string; code: number }> {
		const host = config.hosts[hostKey];
		if (!host) throw new Error(`Unknown host "${hostKey}"`);
		const ghArgs = ['gh', 'api', ...args, '--hostname', host.hostname];
		const cmd = host.proxychains ? ['proxychains4', '-q', '-f', expandHome(host.proxychains), ...ghArgs] : ghArgs;

		const proc = Bun.spawn(cmd, {
			env: ghEnv(host.hostname),
			stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
		try {
			const [out, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (proc.signalCode) throw new Error(`gh timed out after ${TIMEOUT_MS / 1000}s (${host.hostname})`);
			return { out, err, code };
		} finally {
			clearTimeout(timer);
		}
	}

	async function graphql<T>(hostKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
		const { out, err, code } = await spawnGh(hostKey, ['graphql', '--input', '-'], JSON.stringify({ query, variables }));
		let json: GraphQLResponse<T> | null = null;
		try {
			json = out ? (JSON.parse(out) as GraphQLResponse<T>) : null;
		} catch {
			/* not JSON: fall through to the error below */
		}
		const rl = json?.data?.rateLimit;
		if (rl) rate[hostKey] = { ...rl, at: Date.now() };
		if (json?.data) return json.data; // partial data is still useful
		const msg = json?.errors?.map((e) => e.message).join('; ') || err.trim() || `gh exited ${code}`;
		throw new Error(msg);
	}

	async function rest<T>(hostKey: string, path: string): Promise<T> {
		const { out, err, code } = await spawnGh(hostKey, [path]);
		if (code !== 0) throw new Error(err.trim() || `gh exited ${code}`);
		return JSON.parse(out) as T;
	}

	function limited<T>(hostKey: string, fn: () => Promise<T>): Promise<T> {
		const sem = semaphores.get(hostKey);
		if (!sem) return Promise.reject(new Error(`Unknown host "${hostKey}"`));
		return sem.run(fn);
	}

	return {
		rate,
		query: <T>(hostKey: string, query: string, variables: Record<string, unknown> = {}) =>
			limited(hostKey, () => graphql<T>(hostKey, query, variables)),
		get: <T>(hostKey: string, path: string) => limited(hostKey, () => rest<T>(hostKey, path)),
	};
}
