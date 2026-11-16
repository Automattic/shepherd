// Loads and checks config.json (or the file named by SHEPHERD_CONFIG).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { FEATURES, isFeature, resolveFeatures, type Features } from './features.ts';
import { isPushPolicy, PUSH_POLICIES } from './push-policy.ts';
import { MIN_ROW_REFRESH_MS } from './row-refresh.ts';
import { API_VERSION, type Config, type PublicConfig } from './types.ts';

/** The project root (one level above src/). */
export const ROOT = join(import.meta.dir, '..');

export const DEFAULT_PORT = 5050;

export function expandHome(p: string): string {
	return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function fail(message: string): never {
	console.error(message);
	process.exit(1);
}

const POLICY_LIST = PUSH_POLICIES.map((p) => `"${p}"`).join(', ');

/** Checks the shape of a parsed config and returns a list of problems. */
export function problems(c: Partial<Config>): string[] {
	const out: string[] = [];
	if (!Array.isArray(c.team) || !c.team.length) out.push('`team` must be a non-empty array');
	if (!c.hosts || typeof c.hosts !== 'object') out.push('`hosts` must be an object');
	if (!Array.isArray(c.repos) || !c.repos.length) out.push('`repos` must be a non-empty array');
	if (c.refresh !== undefined && c.refresh !== 'rows' && c.refresh !== 'list') out.push('`refresh` must be "rows" or "list", or no such field');
	if (c.linear && (!c.linear.workspace || !Array.isArray(c.linear.keys))) out.push('`linear` needs `workspace` and `keys` (or remove it)');
	if (c.features !== undefined) {
		if (typeof c.features !== 'object' || c.features === null || Array.isArray(c.features)) {
			out.push('`features` must be an object (or remove it)');
		} else {
			for (const [k, v] of Object.entries(c.features)) {
				if (!isFeature(k)) out.push(`\`features.${k}\` is not a feature (use ${FEATURES.slice(0, -1).join(', ')} or ${FEATURES.at(-1)})`);
				else if (typeof v !== 'boolean') out.push(`\`features.${k}\` must be true or false`);
			}
		}
	}
	if (out.length) return out;

	const ids = new Set<string>();
	for (const [i, m] of c.team!.entries()) {
		if (!m.id || !m.name || !m.short) out.push(`team[${i}] needs id, name and short`);
		const legacy = m as unknown as Record<string, unknown>;
		if (!m.logins && (legacy.ghe || legacy.github)) {
			out.push(`team[${i}] (${m.id}) uses the old "ghe"/"github" fields; move them into "logins": { "<host key>": "<login>" }`);
		} else if (!m.logins || typeof m.logins !== 'object' || !Object.keys(m.logins).length) {
			out.push(`team[${i}] (${m.id}) needs "logins": { "<host key>": "<login>" }`);
		} else {
			for (const host of Object.keys(m.logins)) {
				if (!c.hosts![host]) out.push(`team[${i}] (${m.id}) has a login for unknown host "${host}"`);
			}
		}
		if (m.pushPolicy !== undefined && !isPushPolicy(m.pushPolicy)) out.push(`team[${i}] (${m.id}) needs "pushPolicy" to be one of ${POLICY_LIST}, or no such field`);
		if (ids.has(m.id)) out.push(`team id "${m.id}" is used twice`);
		ids.add(m.id);
	}
	if (!c.me || !ids.has(c.me)) out.push(`\`me\` must be one of the team ids (${[...ids].join(', ')})`);
	for (const [key, h] of Object.entries(c.hosts!)) {
		if (!h.hostname) out.push(`hosts.${key} needs a hostname`);
		if (h.reviewTeams !== undefined && !(Array.isArray(h.reviewTeams) && h.reviewTeams.every((t) => typeof t === 'string' && /^[\w.-]+\/[\w.-]+$/.test(t)))) {
			out.push(`hosts.${key}.reviewTeams must be a list of "org/team" names, or no such field`);
		}
		for (const field of ['rowRefreshFloorMs', 'rowRefreshLowBudgetMs'] as const) {
			const v = h[field];
			if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= MIN_ROW_REFRESH_MS)) {
				out.push(`hosts.${key}.${field} must be a number of milliseconds (${MIN_ROW_REFRESH_MS} or more), or no such field`);
			}
		}
		const { rowRefreshFloorMs: floor, rowRefreshLowBudgetMs: low } = h;
		if (typeof floor === 'number' && typeof low === 'number' && low < floor) {
			out.push(`hosts.${key}.rowRefreshLowBudgetMs must not be less than rowRefreshFloorMs: a low budget must not load rows sooner`);
		}
	}
	for (const [i, r] of c.repos!.entries()) {
		if (!c.hosts![r.host]) out.push(`repos[${i}] (${r.owner}/${r.name}) uses unknown host "${r.host}"`);
		if (!r.owner || !r.name || !r.short) out.push(`repos[${i}] needs owner, name and short`);
		if (r.maxBaseAgeHours !== undefined && !(typeof r.maxBaseAgeHours === 'number' && r.maxBaseAgeHours > 0)) {
			out.push(`repos[${i}] (${r.owner}/${r.name}) needs "maxBaseAgeHours" to be a positive number, or no such field`);
		}
		if (r.allAuthors !== undefined && typeof r.allAuthors !== 'boolean') {
			out.push(`repos[${i}] (${r.owner}/${r.name}) needs "allAuthors" to be true or false, or no such field`);
		}
		if (r.pushPolicy !== undefined && !isPushPolicy(r.pushPolicy)) {
			out.push(`repos[${i}] (${r.owner}/${r.name}) needs "pushPolicy" to be one of ${POLICY_LIST}, or no such field`);
		}
		if (r.pushPolicyByAuthor !== undefined) {
			const map = r.pushPolicyByAuthor as unknown;
			if (!map || typeof map !== 'object' || Array.isArray(map)) {
				out.push(`repos[${i}] (${r.owner}/${r.name}) needs "pushPolicyByAuthor" to be an object of team id or login to policy, or no such field`);
			} else {
				for (const [who, policy] of Object.entries(map)) {
					if (!isPushPolicy(policy)) out.push(`repos[${i}] (${r.owner}/${r.name}) pushPolicyByAuthor."${who}" must be one of ${POLICY_LIST}`);
				}
			}
		}
	}
	return out;
}

/** Valid but likely unintended settings. They are printed at startup and don't stop the server. */
export function warnings(c: Config): string[] {
	const out: string[] = [];
	c.repos.forEach((r, i) => {
		if (!r.pushPolicyByAuthor) return;
		const where = `repos[${i}] (${r.owner}/${r.name}) pushPolicyByAuthor`;
		const host = c.hosts[r.host]?.hostname ?? r.host;
		// Which team member or outside login each key names, matched the way resolvePushPolicy matches it.
		const seen = new Map<string, string>();
		for (const key of Object.keys(r.pushPolicyByAuthor)) {
			const k = key.toLowerCase();
			const byId = c.team.find((m) => m.id.toLowerCase() === k);
			const byLogin = c.team.find((m) => m.logins[r.host]?.toLowerCase() === k);
			if (byId && byLogin && byId !== byLogin) {
				out.push(`${where}."${key}" is the team id of ${byId.id} and the ${host} login of ${byLogin.id}; it applies only to ${byId.id}`);
			}
			const who = byId ? `team member ${byId.id}` : byLogin ? `team member ${byLogin.id}` : `the ${host} login "${k}"`;
			if (!byId && !byLogin) {
				out.push(`${where}."${key}" matches no team id or ${host} login on the team, so it applies only to an outside author with that login`);
			}
			const prev = seen.get(who);
			if (prev !== undefined) out.push(`${where}."${key}" and "${prev}" both name ${who}; keep one`);
			else seen.set(who, key);
		}
	});
	return out;
}

export async function loadConfig(): Promise<Config> {
	const file = join(ROOT, process.env.SHEPHERD_CONFIG || 'config.json');
	const f = Bun.file(file);
	if (!(await f.exists())) {
		fail(`No config found at ${file}.\nCopy the example and fill in your team:\n\n  cp config.example.json config.json\n`);
	}
	let parsed: Partial<Config>;
	try {
		parsed = JSON.parse(await f.text()) as Partial<Config>;
	} catch (e) {
		fail(`${file} is not valid JSON: ${(e as Error).message}`);
	}
	const issues = problems(parsed);
	if (issues.length) fail(`${file} has problems:\n${issues.map((p) => `  - ${p}`).join('\n')}`);
	const notes = warnings(parsed as Config);
	if (notes.length) console.warn(`${file} has settings to check:\n${notes.map((p) => `  - ${p}`).join('\n')}`);
	return parsed as Config;
}

/** The features that this server has. herdr.enabled: false turns the herdr chips off too, so the page does not ask for them. */
export function configFeatures(config: Config): Features {
	return resolveFeatures({ ...config.features, ...(config.herdr?.enabled === false ? { herdr: false } : {}) });
}

export function publicConfig(config: Config): PublicConfig {
	return {
		apiVersion: API_VERSION,
		me: config.me,
		team: config.team,
		repos: config.repos,
		hosts: Object.fromEntries(
			Object.entries(config.hosts).map(([k, h]) => [
				k,
				{ hostname: h.hostname, label: h.label, bot: h.bot, rowRefreshFloorMs: h.rowRefreshFloorMs, rowRefreshLowBudgetMs: h.rowRefreshLowBudgetMs },
			])
		),
		linear: config.linear ?? null,
		aiReviewLabel: config.aiReviewLabel || 'AI review',
		features: configFeatures(config),
		refresh: config.refresh ?? 'rows',
	};
}
