// Loads and checks config.json (or the file named by SHEPHERD_CONFIG).

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, PublicConfig } from './types.ts';

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

/** Checks the shape of a parsed config and returns a list of problems. */
function problems(c: Partial<Config>): string[] {
	const out: string[] = [];
	if (!Array.isArray(c.team) || !c.team.length) out.push('`team` must be a non-empty array');
	if (!c.hosts || typeof c.hosts !== 'object') out.push('`hosts` must be an object');
	if (!Array.isArray(c.repos) || !c.repos.length) out.push('`repos` must be a non-empty array');
	if (c.linear && (!c.linear.workspace || !Array.isArray(c.linear.keys))) out.push('`linear` needs `workspace` and `keys` (or remove it)');
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
		if (ids.has(m.id)) out.push(`team id "${m.id}" is used twice`);
		ids.add(m.id);
	}
	if (!c.me || !ids.has(c.me)) out.push(`\`me\` must be one of the team ids (${[...ids].join(', ')})`);
	for (const [key, h] of Object.entries(c.hosts!)) {
		if (!h.hostname) out.push(`hosts.${key} needs a hostname`);
		if (h.reviewTeams !== undefined && !(Array.isArray(h.reviewTeams) && h.reviewTeams.every((t) => typeof t === 'string' && /^[\w.-]+\/[\w.-]+$/.test(t)))) {
			out.push(`hosts.${key}.reviewTeams must be a list of "org/team" names, or no such field`);
		}
	}
	for (const [i, r] of c.repos!.entries()) {
		if (!c.hosts![r.host]) out.push(`repos[${i}] (${r.owner}/${r.name}) uses unknown host "${r.host}"`);
		if (!r.owner || !r.name || !r.short) out.push(`repos[${i}] needs owner, name and short`);
		if (r.maxBaseAgeHours !== undefined && !(typeof r.maxBaseAgeHours === 'number' && r.maxBaseAgeHours > 0)) {
			out.push(`repos[${i}] (${r.owner}/${r.name}) needs "maxBaseAgeHours" to be a positive number, or no such field`);
		}
	}
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
	return parsed as Config;
}

export function publicConfig(config: Config): PublicConfig {
	return {
		me: config.me,
		team: config.team,
		repos: config.repos,
		hosts: Object.fromEntries(
			Object.entries(config.hosts).map(([k, h]) => [k, { hostname: h.hostname, label: h.label, bot: h.bot }])
		),
		linear: config.linear ?? null,
		aiReviewLabel: config.aiReviewLabel || 'AI review',
	};
}
