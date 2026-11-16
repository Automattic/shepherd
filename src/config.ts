// Loads and checks config.json (or the file named by SHEPHERD_CONFIG).

import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveFeatures, type Features } from './features.ts';
import { fromPointer, validate } from './schema.ts';
import { documentFromConfig, localRules } from './settings.ts';
import { SETTINGS_SCHEMA } from './settings-schema.ts';
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

/** config.json keeps review teams under `hosts.<key>`, so messages name them there. */
function configPath(segments: string[]): string[] {
	return segments[0] === 'reviewTeams' && segments.length > 1 ? ['hosts', segments[1]!, 'reviewTeams', ...segments.slice(2)] : segments;
}

/**
 * Checks a parsed config and returns a list of problems. The rules are the settings schema
 * (src/settings-schema.ts), plus `localRules()` of this server.
 */
export function problems(c: Partial<Config>): string[] {
	const doc = documentFromConfig(c);
	const out = validate(SETTINGS_SCHEMA, doc, { rewritePath: configPath }).map((e) => {
		// A config from before `logins` gets a hint on how to move it.
		const [, area, list, index, field] = fromPointer(e.pointer);
		const legacy = area === 'personal' && list === 'team' && field === 'logins' && e.keyword === 'required' ? (c.team?.[Number(index)] as unknown as Record<string, unknown>) : undefined;
		if (legacy && (legacy.ghe || legacy.github)) {
			return `team[${index}] (${String(legacy.id)}) uses the old "ghe"/"github" fields; move them into "logins": { "<host key>": "<login>" }`;
		}
		return e.message;
	});
	if (Array.isArray(c.repos)) out.push(...localRules({ repos: c.repos }).map((e) => e.message));
	// A message can come from more than one check (an item with neither id nor name, for example).
	return [...new Set(out)];
}

/** Valid but likely unintended settings. They are printed at startup and don't stop the server. */
export function warnings(c: Config): string[] {
	const out: string[] = [];
	for (const [key, h] of Object.entries(c.hosts)) {
		// problems() already checked that each value is a number of MIN_ROW_REFRESH_MS or more.
		const { rowRefreshFloorMs: floor, rowRefreshLowBudgetMs: low } = h;
		if (floor !== undefined && low !== undefined && low < floor) {
			out.push(`hosts.${key}.rowRefreshLowBudgetMs (${low}) is less than rowRefreshFloorMs (${floor}); when the budget is low, the page uses the floor`);
		}
	}
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

/** The config file, its text and its config. A broken file stops the process: startup is the only place that exits. */
export async function loadConfig(): Promise<{ file: string; text: string; config: Config }> {
	const file = join(ROOT, process.env.SHEPHERD_CONFIG || 'config.json');
	const f = Bun.file(file);
	if (!(await f.exists())) {
		fail(`No config found at ${file}.\nCopy the example and fill in your team:\n\n  cp config.example.json config.json\n`);
	}
	const text = await f.text();
	let parsed: Partial<Config>;
	try {
		parsed = JSON.parse(text) as Partial<Config>;
	} catch (e) {
		fail(`${file} is not valid JSON: ${(e as Error).message}`);
	}
	const issues = problems(parsed);
	if (issues.length) fail(`${file} has problems:\n${issues.map((p) => `  - ${p}`).join('\n')}`);
	const notes = warnings(parsed as Config);
	if (notes.length) console.warn(`${file} has settings to check:\n${notes.map((p) => `  - ${p}`).join('\n')}`);
	return { file, text, config: parsed as Config };
}

/**
 * The features that this server has. herdr.enabled: false turns the herdr chips off too, so the page does not ask for them.
 * The local server always has the settings API.
 */
export function configFeatures(config: Config): Features {
	return resolveFeatures({ ...config.features, ...(config.herdr?.enabled === false ? { herdr: false } : {}), settings: true });
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
		// The local server has no team or member views.
		mode: 'personal',
	};
}
