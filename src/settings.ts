// The settings model: how config.json maps to a SettingsDocument, and the checks of PUT /api/settings.
// No I/O here, so the server, its tests and the browser client can share it. settings-store.ts reads and
// writes config.json; settings-schema.ts is the rulebook.

import { fromPointer, toPointer, validate, valuesAt } from './schema.ts';
import { SETTINGS_SCHEMA } from './settings-schema.ts';
import type {
	Config,
	DeploymentSettings,
	FieldMeta,
	PersonalSettings,
	RepoConfig,
	SettingsDocument,
	SettingsErrorResponse,
	SettingsFieldError,
	SettingsResponse,
	TeamMember,
} from './types.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copies `source[key]` into `target` only when it is there, so a missing key stays missing for the schema. */
function copy(target: Record<string, unknown>, source: Record<string, unknown>, key: string, as = key): void {
	if (source[key] !== undefined) target[as] = source[key];
}

/**
 * The settings document of a config, as the schema sees it. It accepts a broken config too, so that
 * `problems()` can report on it: a missing key stays missing.
 */
export function documentFromConfig(c: Partial<Config>): SettingsDocument {
	const raw = c as Record<string, unknown>;
	const personal: Record<string, unknown> = {};
	copy(personal, raw, 'me');
	copy(personal, raw, 'team');
	copy(personal, raw, 'repos');
	copy(personal, raw, 'linear');
	copy(personal, raw, 'features');
	const deployment: Record<string, unknown> = {};
	if (isObject(raw.hosts)) {
		const reviewTeams: Record<string, unknown> = {};
		const hosts: Record<string, unknown> = {};
		for (const [key, h] of Object.entries(raw.hosts)) {
			if (!isObject(h)) {
				hosts[key] = h;
				continue;
			}
			const { reviewTeams: teams, proxychains: _proxychains, ...rest } = h;
			hosts[key] = rest;
			if (teams !== undefined) reviewTeams[key] = teams;
		}
		personal.reviewTeams = reviewTeams;
		deployment.hosts = hosts;
	} else {
		copy(deployment, raw, 'hosts');
	}
	copy(deployment, raw, 'refresh');
	copy(deployment, raw, 'aiReviewLabel');
	copy(deployment, raw, 'ignoreParticipants');
	copy(deployment, raw, 'limits');
	return { personal, deployment } as unknown as SettingsDocument;
}

/** The settings of a valid config, with the defaults of the optional fields filled in. A copy: a change to it does not change `config`. */
export function settingsFromConfig(source: Config): SettingsDocument {
	const config = structuredClone(source);
	const doc = documentFromConfig(config);
	const personal: PersonalSettings = {
		me: config.me,
		team: config.team,
		repos: config.repos,
		reviewTeams: doc.personal.reviewTeams ?? {},
		linear: config.linear ?? null,
		features: config.features ?? {},
	};
	const deployment: DeploymentSettings = {
		hosts: Object.fromEntries(
			Object.entries(config.hosts).map(([k, h]) => [
				k,
				{
					hostname: h.hostname,
					label: h.label,
					bot: h.bot,
					...(h.concurrency !== undefined ? { concurrency: h.concurrency } : {}),
					...(h.rowRefreshFloorMs !== undefined ? { rowRefreshFloorMs: h.rowRefreshFloorMs } : {}),
					...(h.rowRefreshLowBudgetMs !== undefined ? { rowRefreshLowBudgetMs: h.rowRefreshLowBudgetMs } : {}),
				},
			])
		),
		refresh: config.refresh ?? 'rows',
		aiReviewLabel: config.aiReviewLabel || 'AI review',
		ignoreParticipants: config.ignoreParticipants ?? [],
		limits: config.limits ?? {},
	};
	return { personal, deployment };
}

/**
 * The parsed config.json with the personal settings put in. Every other key stays as it was on disk,
 * including the keys that the API never sends (`proxychains`, `port`, `herdr`).
 */
export function mergePersonal(onDisk: Record<string, unknown>, personal: PersonalSettings): Record<string, unknown> {
	const out: Record<string, unknown> = { ...onDisk, me: personal.me, team: personal.team, repos: personal.repos };
	if (personal.linear !== null || onDisk.linear !== undefined) out.linear = personal.linear;
	if (Object.keys(personal.features).length || onDisk.features !== undefined) out.features = personal.features;
	if (isObject(onDisk.hosts)) {
		out.hosts = Object.fromEntries(
			Object.entries(onDisk.hosts).map(([key, h]) => {
				if (!isObject(h)) return [key, h];
				const { reviewTeams: _old, ...rest } = h;
				const teams = personal.reviewTeams[key];
				return [key, teams?.length ? { ...rest, reviewTeams: teams } : rest];
			})
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Field metadata

/** True when the pointer `pattern` (with `*` segments) matches `pointer` or one of its parents. */
function covers(pattern: string[], pointer: string[]): boolean {
	return pattern.length <= pointer.length && pattern.every((seg, i) => seg === '*' || seg === pointer[i]);
}

/** The metadata of a field: the longest pointer in `fields` that matches it. Without one, a personal field is editable. */
export function fieldMeta(fields: Record<string, FieldMeta>, pointer: string): FieldMeta {
	const segments = fromPointer(pointer);
	let best: { length: number; meta: FieldMeta } | null = null;
	for (const [key, meta] of Object.entries(fields)) {
		const pattern = fromPointer(key);
		if (covers(pattern, segments) && (!best || pattern.length > best.length)) best = { length: pattern.length, meta };
	}
	return best?.meta ?? { editable: segments[0] === 'personal' };
}

// ---------------------------------------------------------------------------
// Push policy owners

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const repoId = (r: Pick<RepoConfig, 'host' | 'owner' | 'name'>): string => `${r.host}/${r.owner}/${r.name}`.toLowerCase();

/** True when a `pushPolicyByAuthor` key names the viewer: their team id, or their login on the repo's host. */
export function namesViewer(key: string, viewer: TeamMember | undefined, host: string): boolean {
	if (!viewer) return false;
	const login = viewer.logins[host];
	return same(key, viewer.id) || (login !== undefined && same(key, login));
}

/** Changes to push policies that are not the viewer's own. A viewer never sets another person's policy. */
function pushPolicyChanges(prev: PersonalSettings, next: PersonalSettings): SettingsFieldError[] {
	const errors: SettingsFieldError[] = [];
	const viewer = next.team.find((m) => m.id === next.me);
	const prevById = new Map(prev.team.map((m) => [m.id, m]));
	next.team.forEach((m, i) => {
		if (m.id === next.me) return;
		if ((m.pushPolicy ?? null) !== (prevById.get(m.id)?.pushPolicy ?? null)) {
			errors.push({
				path: toPointer(['personal', 'team', i, 'pushPolicy']),
				code: 'not_editable',
				message: `Only ${m.name || m.id} can change their push policy.`,
			});
		}
	});
	const prevRepos = new Map(prev.repos.map((r) => [repoId(r), r]));
	next.repos.forEach((r, i) => {
		const before = prevRepos.get(repoId(r))?.pushPolicyByAuthor ?? {};
		const after = r.pushPolicyByAuthor ?? {};
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (before[key] === after[key] || namesViewer(key, viewer, r.host)) continue;
			errors.push({
				path: toPointer(['personal', 'repos', i, 'pushPolicyByAuthor', key]),
				code: 'not_editable',
				message: `Only ${key} can change their push policy in ${r.owner}/${r.name}.`,
			});
		}
	});
	return errors;
}

// ---------------------------------------------------------------------------
// PUT /api/settings

/** The rules of the local server that the shared schema does not have: it finds PRs only in the listed repos. */
export function localRules(personal: Pick<PersonalSettings, 'repos'>): SettingsFieldError[] {
	return Array.isArray(personal.repos) && personal.repos.length === 0
		? [{ path: '/personal/repos', code: 'refused', message: '`repos` must be a non-empty array' }]
		: [];
}

/** The cost limits that apply to the personal settings. */
function limitErrors(next: PersonalSettings, current: SettingsResponse): SettingsFieldError[] {
	const { maxPeople, maxRepos } = current.deployment.limits;
	const errors: SettingsFieldError[] = [];
	if (maxPeople !== undefined && next.team.length > maxPeople) {
		errors.push({ path: '/personal/team', code: 'limit', message: `This server allows up to ${maxPeople} people; remove ${next.team.length - maxPeople}.` });
	}
	if (maxRepos !== undefined && next.repos.length > maxRepos) {
		errors.push({ path: '/personal/repos', code: 'limit', message: `This server allows up to ${maxRepos} repos; remove ${next.repos.length - maxRepos}.` });
	}
	return errors;
}

/** Changed values at pointers that are not editable. */
function notEditableChanges(prev: SettingsDocument, next: SettingsDocument, fields: Record<string, FieldMeta>): SettingsFieldError[] {
	const errors: SettingsFieldError[] = [];
	for (const [pointer, meta] of Object.entries(fields)) {
		if (meta.editable || !pointer.startsWith('/personal')) continue;
		if (JSON.stringify(valuesAt(prev, pointer)) === JSON.stringify(valuesAt(next, pointer))) continue;
		errors.push({ path: pointer, code: 'not_editable', message: meta.reason || 'This setting is not editable.' });
	}
	return errors;
}

export interface PutContext {
	current: SettingsResponse;
	/** Refusals of the host for a value that the schema accepts, for example a repo the viewer may not watch. */
	refuse?: (next: PersonalSettings, current: SettingsResponse) => SettingsFieldError[];
}

export type PutResult = { ok: true; personal: PersonalSettings } | { ok: false; status: 400 | 409 | 422; body: SettingsErrorResponse };

const refused = (status: 400 | 409 | 422, error: string, errors: SettingsFieldError[] = [], settings?: SettingsResponse): PutResult => ({
	ok: false,
	status,
	body: settings ? { error, errors, settings } : { error, errors },
});

/** Checks the body of PUT /api/settings against the current settings. */
export function checkSettingsPut(body: unknown, { current, refuse }: PutContext): PutResult {
	if (!isObject(body) || typeof body.version !== 'string' || !isObject(body.personal)) {
		return refused(400, 'bad request: send { "version": "<from GET /api/settings>", "personal": { … } }');
	}
	const extra = Object.keys(body).filter((k) => k !== 'version' && k !== 'personal');
	if (extra.length) {
		const errors = extra.map((k): SettingsFieldError =>
			k === 'deployment'
				? { path: '/deployment', code: 'not_editable', message: fieldMeta(current.fields, '/deployment').reason || 'Deployment settings belong to the server.' }
				: { path: toPointer([k]), code: 'invalid', message: `${k} is not part of a settings request` }
		);
		return refused(422, 'Some settings were refused.', errors);
	}
	if (body.version !== current.version) {
		return refused(409, 'The settings changed since you loaded them (in another tab, or on the server). Load them again and repeat your change.', [], current);
	}
	const next: SettingsDocument = { personal: body.personal as unknown as PersonalSettings, deployment: current.deployment };
	const invalid = validate(SETTINGS_SCHEMA, next).map((e): SettingsFieldError => ({ path: e.pointer, code: 'invalid', message: e.message }));
	if (invalid.length) return refused(422, 'Some settings are not valid.', invalid);
	const errors = [
		...notEditableChanges(current, next, current.fields),
		...pushPolicyChanges(current.personal, next.personal),
		...limitErrors(next.personal, current),
		...(refuse?.(next.personal, current) ?? []),
	];
	if (errors.length) return refused(422, 'Some settings were refused.', errors);
	return { ok: true, personal: next.personal };
}
