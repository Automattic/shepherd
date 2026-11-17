// The settings model: how config.json maps to a SettingsDocument, and the checks of PUT /api/settings.
// No I/O here, so the server, its tests and the browser client can share it. settings-store.ts reads and
// writes config.json; settings-schema.ts is the rulebook.

import { fromPointer, toPointer, validate } from './schema.ts';
import { SETTINGS_SCHEMA } from './settings-schema.ts';
import type {
	Config,
	DeploymentSettings,
	FieldMeta,
	PersonalSettings,
	SettingsDocument,
	SettingsErrorResponse,
	SettingsFieldError,
	SettingsResponse,
} from './types.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sets an own property, also for a key such as `__proto__`, which plain assignment turns into a prototype change. */
const own = (o: Record<string, unknown>, key: string, value: unknown): void => {
	Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
};

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
		const anyRepo: Record<string, unknown> = {};
		const hosts: Record<string, unknown> = {};
		for (const [key, h] of Object.entries(raw.hosts)) {
			if (!isObject(h)) {
				own(hosts, key, h);
				continue;
			}
			const { reviewTeams: teams, anyRepo: scope, proxychains: _proxychains, ...rest } = h;
			own(hosts, key, rest);
			if (teams !== undefined) own(reviewTeams, key, teams);
			if (scope !== undefined) own(anyRepo, key, scope);
		}
		personal.reviewTeams = reviewTeams;
		personal.anyRepo = anyRepo;
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
		anyRepo: doc.personal.anyRepo ?? {},
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
					...(h.botsByOwner !== undefined ? { botsByOwner: h.botsByOwner } : {}),
					...(h.proxychains ? { proxied: true } : {}),
					...(h.concurrency !== undefined ? { concurrency: h.concurrency } : {}),
					...(h.rowRefreshFloorMs !== undefined ? { rowRefreshFloorMs: h.rowRefreshFloorMs } : {}),
					...(h.rowRefreshLowBudgetMs !== undefined ? { rowRefreshLowBudgetMs: h.rowRefreshLowBudgetMs } : {}),
					...(h.defaultOrgs !== undefined ? { defaultOrgs: h.defaultOrgs } : {}),
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
				const { reviewTeams: _old, anyRepo: oldScope, ...rest } = h;
				const teams = personal.reviewTeams[key];
				const out: Record<string, unknown> = teams?.length ? { ...rest, reviewTeams: teams } : rest;
				// Without `anyRepo` in the settings, each host keeps what it has on disk.
				const scope = personal.anyRepo ? (Object.hasOwn(personal.anyRepo, key) ? personal.anyRepo[key] : undefined) : oldScope;
				if (scope !== undefined) out.anyRepo = scope;
				return [key, out];
			})
		);
	}
	return out;
}

/**
 * The parsed config.json with the hosts of a settings request: hosts that the request does not have are removed, new ones
 * are added, and each host takes `hostname`, `label`, `bot` and `botsByOwner` from the request. The other fields of a host
 * (`proxychains`, `concurrency`, the refresh floors, `reviewTeams`) stay as they are on disk.
 */
export function mergeHosts(onDisk: Record<string, unknown>, hosts: DeploymentSettings['hosts']): Record<string, unknown> {
	const before = isObject(onDisk.hosts) ? onDisk.hosts : {};
	const out: Record<string, unknown> = {};
	for (const [key, h] of Object.entries(hosts)) {
		const was = Object.hasOwn(before, key) && isObject(before[key]) ? before[key] : {};
		const next: Record<string, unknown> = { ...was, hostname: h.hostname };
		if (h.label !== undefined) next.label = h.label;
		else delete next.label;
		if (h.bot !== undefined) next.bot = h.bot;
		else delete next.bot;
		if (h.botsByOwner !== undefined && Object.keys(h.botsByOwner).length) next.botsByOwner = h.botsByOwner;
		else delete next.botsByOwner;
		own(out, key, next);
	}
	return { ...onDisk, hosts: out };
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
// PUT /api/settings

/** The cost limits that apply to the personal settings. */
function limitErrors(next: PersonalSettings, current: SettingsResponse): SettingsFieldError[] {
	const { maxPeople, maxRepos, maxOrgs } = current.deployment.limits;
	const errors: SettingsFieldError[] = [];
	if (maxPeople !== undefined && next.team.length > maxPeople) {
		errors.push({ path: '/personal/team', code: 'limit', message: `This server allows up to ${maxPeople} people; remove ${next.team.length - maxPeople}.` });
	}
	if (maxRepos !== undefined && next.repos.length > maxRepos) {
		errors.push({ path: '/personal/repos', code: 'limit', message: `This server allows up to ${maxRepos} repos; remove ${next.repos.length - maxRepos}.` });
	}
	// An org opens every repo in it, so the orgs of `anyRepo` have their own cap.
	const orgs = Object.values(next.anyRepo ?? {}).reduce((n, s) => n + (Array.isArray(s?.orgs) ? s.orgs.length : 0), 0);
	if (maxOrgs !== undefined && orgs > maxOrgs) {
		errors.push({ path: '/personal/anyRepo', code: 'limit', message: `This server allows up to ${maxOrgs} orgs for any repo; remove ${orgs - maxOrgs}.` });
	}
	return errors;
}

/** A name for an array item that stays the same when the array is reordered: a member's id, a repo's host and name. */
function identity(item: unknown, index: number): string {
	if (isObject(item)) {
		if (typeof item.id === 'string') return `id:${item.id}`;
		if (typeof item.owner === 'string' && typeof item.name === 'string') return `repo:${String(item.host)}/${item.owner}/${item.name}`.toLowerCase();
	}
	return `#${index}`;
}

interface Match {
	/** The concrete pointer in the document, with array indexes. */
	pointer: string;
	/** The same place, with array items named by `identity()`, so the two documents can be compared item by item. */
	id: string;
	/** The `id` of the parent of the matched value. */
	parent: string;
	value: unknown;
}

/**
 * Every place in `doc` that `pattern` (whose segments can be `*`) names. A pattern whose last segment is not `*`
 * also matches where that key is missing, with `value` undefined, as long as its parent is there.
 */
function matches(doc: unknown, pattern: string): Match[] {
	let current: { segs: string[]; ids: string[]; value: unknown; present: boolean }[] = [{ segs: [], ids: [], value: doc, present: true }];
	for (const seg of fromPointer(pattern)) {
		const next: typeof current = [];
		for (const c of current) {
			if (!c.present) continue;
			const v = c.value;
			if (seg === '*') {
				if (Array.isArray(v)) v.forEach((item, i) => next.push({ segs: [...c.segs, String(i)], ids: [...c.ids, identity(item, i)], value: item, present: true }));
				else if (isObject(v)) for (const [k, item] of Object.entries(v)) next.push({ segs: [...c.segs, k], ids: [...c.ids, k], value: item, present: true });
			} else if (Array.isArray(v) && /^\d+$/.test(seg)) {
				const i = Number(seg);
				next.push({ segs: [...c.segs, seg], ids: [...c.ids, identity(v[i], i)], value: v[i], present: i < v.length });
			} else if (isObject(v)) {
				next.push({ segs: [...c.segs, seg], ids: [...c.ids, seg], value: Object.hasOwn(v, seg) ? v[seg] : undefined, present: Object.hasOwn(v, seg) });
			}
		}
		current = next;
	}
	return current.map((c) => ({ pointer: toPointer(c.segs), id: c.ids.join('/'), parent: c.ids.slice(0, -1).join('/'), value: c.value }));
}

/** JSON with the keys of every object sorted, so that the order of keys is never a change. Arrays keep their order. */
function stableJson(v: unknown): string {
	const sort = (x: unknown): unknown =>
		Array.isArray(x) ? x.map(sort) : isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
	return JSON.stringify(sort(v)) ?? 'undefined';
}

/** `value` without the parts at `rest` (segments below it, `*` for any item). For masking editable fields inside a locked one. */
function without(value: unknown, rest: string[]): unknown {
	if (!rest.length) return undefined;
	const [seg, ...more] = rest as [string, ...string[]];
	if (Array.isArray(value)) {
		return value.map((item, i) => (seg === '*' || seg === String(i) ? without(item, more) : item)).filter((item) => item !== undefined);
	}
	if (isObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (seg === '*' || seg === k) {
				const kept = without(v, more);
				if (kept !== undefined) out[k] = kept;
			} else out[k] = v;
		}
		return out;
	}
	return value;
}

/**
 * Changed values at places that are not editable. Each pointer of `fields` that is not editable is checked at every
 * place it names, by array item identity (so moving a value from one member to another counts as a change), and each
 * place is judged by the longest matching pointer, as the panel judges it. Editable fields inside a locked one are left out
 * of the comparison. A removed array item or key is not a change to its locked fields.
 */
function notEditableChanges(prev: SettingsDocument, next: SettingsDocument, fields: Record<string, FieldMeta>): SettingsFieldError[] {
	const errors: SettingsFieldError[] = [];
	const seen = new Set<string>();
	for (const [pattern, meta] of Object.entries(fields)) {
		if (meta.editable) continue;
		// Editable fields inside this locked one, as segments below it.
		const holes = Object.entries(fields)
			.filter(([p, m]) => m.editable && p.startsWith(`${pattern}/`))
			.map(([p]) => fromPointer(p).slice(fromPointer(pattern).length));
		const mask = (v: unknown) => stableJson(holes.reduce((acc, hole) => without(acc, hole), v));
		const before = new Map(matches(prev, pattern).map((m) => [m.id, m]));
		const after = matches(next, pattern);
		const afterIds = new Set(after.map((m) => m.id));
		const afterParents = new Set(after.map((m) => m.parent));
		const changed: Match[] = after.filter((m) => mask(m.value) !== mask(before.get(m.id)?.value));
		// A value that is gone while its parent stays, such as a removed per-author entry.
		for (const m of before.values()) if (!afterIds.has(m.id) && afterParents.has(m.parent) && m.value !== undefined) changed.push(m);
		for (const m of changed) {
			const own = fieldMeta(fields, m.pointer);
			if (own.editable || seen.has(m.pointer)) continue;
			seen.add(m.pointer);
			errors.push({ path: m.pointer, code: 'not_editable', message: own.reason || meta.reason || 'This setting is not editable.' });
		}
	}
	return errors;
}

/** The host fields that a settings request can set. The others (concurrency, refresh floors) stay as the server has them. */
const HOST_FIELDS = ['hostname', 'label', 'bot', 'botsByOwner'] as const;

/**
 * The deployment settings after a request: the current ones, with the request's hosts when it sends them. A host keeps its
 * other fields; a field that the request sets outside HOST_FIELDS to a new value is refused.
 */
function nextDeployment(body: Record<string, unknown>, current: DeploymentSettings): { deployment: DeploymentSettings; errors: SettingsFieldError[] } {
	const errors: SettingsFieldError[] = [];
	if (body.deployment === undefined) return { deployment: current, errors };
	if (!isObject(body.deployment)) return { deployment: current, errors: [{ path: '/deployment', code: 'invalid', message: '`deployment` must be an object with `hosts`' }] };
	for (const key of Object.keys(body.deployment)) {
		if (key !== 'hosts' && JSON.stringify(body.deployment[key]) !== JSON.stringify((current as unknown as Record<string, unknown>)[key])) {
			errors.push({ path: toPointer(['deployment', key]), code: 'not_editable', message: 'Only the hosts of the deployment settings can be changed.' });
		}
	}
	const sent = body.deployment.hosts;
	if (sent === undefined) return { deployment: current, errors };
	if (!isObject(sent)) return { deployment: { ...current, hosts: sent as DeploymentSettings['hosts'] }, errors };
	const hosts: Record<string, unknown> = {};
	for (const [key, h] of Object.entries(sent)) {
		if (!isObject(h)) {
			own(hosts, key, h);
			continue;
		}
		const was = Object.hasOwn(current.hosts, key) ? (current.hosts[key] as unknown as Record<string, unknown>) : {};
		const out: Record<string, unknown> = { ...was };
		for (const f of HOST_FIELDS) {
			if (h[f] === undefined) delete out[f];
			else out[f] = h[f];
		}
		for (const [f, v] of Object.entries(h)) {
			if ((HOST_FIELDS as readonly string[]).includes(f) || JSON.stringify(v) === JSON.stringify(was[f])) continue;
			errors.push({ path: toPointer(['deployment', 'hosts', key, f]), code: 'not_editable', message: `${f} is set in config.json on the server.` });
		}
		own(hosts, key, out);
	}
	return { deployment: { ...current, hosts: hosts as DeploymentSettings['hosts'] }, errors };
}

/** The keys that a settings request must send in `personal`, all of them, so that a missing one never deletes a setting. */
const PERSONAL_KEYS = ['me', 'team', 'repos', 'reviewTeams', 'linear', 'features'] as const;

export interface PutContext {
	current: SettingsResponse;
	/** Refusals of the host for a value that the schema accepts, for example a repo the viewer may not watch. */
	refuse?: (next: PersonalSettings, current: SettingsResponse, deployment: DeploymentSettings) => SettingsFieldError[];
}

export type PutResult = { ok: true; personal: PersonalSettings; deployment: DeploymentSettings } | { ok: false; status: 400 | 409 | 422; body: SettingsErrorResponse };

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
	const extra = Object.keys(body).filter((k) => k !== 'version' && k !== 'personal' && k !== 'deployment');
	if (extra.length) {
		return refused(
			422,
			'Some settings were refused.',
			extra.map((k): SettingsFieldError => ({ path: toPointer([k]), code: 'invalid', message: `${k} is not part of a settings request` }))
		);
	}
	if (body.version !== current.version) {
		return refused(409, 'The settings changed since you loaded them (in another tab, or on the server). Load them again and repeat your change.', [], current);
	}
	const sent = body.personal;
	const missing = PERSONAL_KEYS.filter((k) => !Object.hasOwn(sent, k)).map(
		(k): SettingsFieldError => ({ path: toPointer(['personal', k]), code: 'invalid', message: `send \`${k}\` too: a settings request has every personal setting, so a missing one is never deleted` })
	);
	if (missing.length) return refused(422, 'Some settings are not valid.', missing);
	const { deployment, errors: hostErrors } = nextDeployment(body, current.deployment);
	if (hostErrors.length) return refused(422, 'Some settings were refused.', hostErrors);
	// `anyRepo` is newer than the other keys, so a request without it keeps the current value instead of deleting it,
	// less the hosts that the request removes (an older client cannot show an error about them).
	const hosts = isObject(deployment.hosts) ? deployment.hosts : {};
	const personal = Object.hasOwn(sent, 'anyRepo')
		? sent
		: { ...sent, anyRepo: Object.fromEntries(Object.entries(current.personal.anyRepo ?? {}).filter(([k]) => Object.hasOwn(hosts, k)).map(([k, v]) => [k, structuredClone(v)])) };
	const next: SettingsDocument = { personal: personal as unknown as PersonalSettings, deployment };
	const invalid = validate(SETTINGS_SCHEMA, next).map((e): SettingsFieldError => ({ path: e.pointer, code: 'invalid', message: e.message }));
	if (invalid.length) return refused(422, 'Some settings are not valid.', invalid);
	const errors = [...notEditableChanges(current, next, current.fields), ...limitErrors(next.personal, current), ...(refuse?.(next.personal, current, next.deployment) ?? [])];
	if (errors.length) return refused(422, 'Some settings were refused.', errors);
	return { ok: true, personal: next.personal, deployment: next.deployment };
}
