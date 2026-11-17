// Moving personal settings between Shepherd servers: a file that one server's panel exports and another's imports,
// for example from the local server to a host that embeds the client. No I/O here, so the panel and the tests share it.
//
// Servers can name the same GitHub host with different keys, so the file says which host name each key is, and an import
// moves logins, repos and review teams to the key that the target server uses for that host name.

import { validate } from './schema.ts';
import { fieldMeta } from './settings.ts';
import { SETTINGS_SCHEMA } from './settings-schema.ts';
import type { DeploymentSettings, PersonalSettings, PushPolicy, SettingsResponse, TeamMember } from './types.ts';

export const SETTINGS_FILE_FORMAT = 'shepherd-settings';
export const SETTINGS_FILE_VERSION = 1;

/** The exported file. */
export interface SettingsFile {
	format: typeof SETTINGS_FILE_FORMAT;
	version: typeof SETTINGS_FILE_VERSION;
	exportedAt: string;
	/** The hosts of the server, by key: so an import can match them by host name, and add the ones a server lacks where it can. */
	hosts: Record<string, Pick<DeploymentSettings['hosts'][string], 'hostname' | 'label' | 'bot' | 'botsByOwner'>>;
	personal: PersonalSettings;
}

export interface ImportResult {
	/** The settings to put in the panel. They are not saved; the viewer reviews them and saves. */
	personal: PersonalSettings;
	/** The hosts with the file's hosts that the server lacked, when the server lets the viewer add hosts. */
	hosts?: DeploymentSettings['hosts'];
	/** What the import left out or kept from the current settings, in words for the viewer. */
	notes: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file for the saved settings of a server. */
export function exportSettings(settings: Pick<SettingsResponse, 'personal' | 'deployment'>, now: Date = new Date()): SettingsFile {
	return {
		format: SETTINGS_FILE_FORMAT,
		version: SETTINGS_FILE_VERSION,
		exportedAt: now.toISOString(),
		hosts: Object.fromEntries(
			Object.entries(settings.deployment.hosts).map(([k, h]) => [
				k,
				{ hostname: h.hostname, label: h.label, bot: h.bot, ...(h.botsByOwner ? { botsByOwner: structuredClone(h.botsByOwner) } : {}) },
			])
		),
		personal: structuredClone(settings.personal),
	};
}

/** Throws an Error with a message for the viewer when `file` is not a settings file this version can read. */
function checkFile(file: unknown): SettingsFile {
	if (!isObject(file) || file.format !== SETTINGS_FILE_FORMAT) throw new Error('This is not a Shepherd settings file.');
	if (file.version !== SETTINGS_FILE_VERSION) throw new Error(`This settings file has version ${String(file.version)}; this Shepherd reads version ${SETTINGS_FILE_VERSION}.`);
	if (!isObject(file.hosts) || !isObject(file.personal)) throw new Error('This settings file has no hosts or no personal settings.');
	const p = file.personal;
	if (!Array.isArray(p.team) || !Array.isArray(p.repos)) throw new Error('This settings file has no team or no repos.');
	return file as unknown as SettingsFile;
}

/**
 * The settings of `file`, made to fit the `current` server: host keys follow host names, the viewer stays who they are
 * there (matched by a login, never by an id alone), and a field that is not editable there keeps its current value. The result still goes through the server's
 * checks when the viewer saves.
 */
export function importSettings(raw: unknown, current: Pick<SettingsResponse, 'personal' | 'deployment' | 'fields'>): ImportResult {
	const file = checkFile(raw);
	const notes: string[] = [];
	const editable = (pointer: string) => fieldMeta(current.fields, pointer).editable;

	// The file must be valid settings in its own terms (its hosts are the ones its logins and repos name), so a wrong type
	// or a crafted value never reaches the panel.
	const own = validate(SETTINGS_SCHEMA, { personal: file.personal, deployment: { hosts: file.hosts } });
	if (own.length) throw new Error(`This settings file has values that Shepherd cannot use: ${own.slice(0, 3).map((e) => e.message).join('; ')}${own.length > 3 ? '; …' : ''}`);

	// Source host key -> target host key, by host name.
	const targetByHostname = new Map(Object.entries(current.deployment.hosts).map(([k, h]) => [h.hostname.toLowerCase(), k]));
	const keyMap = new Map<string, string>();
	const missing: string[] = [];
	const canAddHosts = editable('/deployment/hosts');
	let hosts: DeploymentSettings['hosts'] | undefined;
	for (const [k, h] of Object.entries(file.hosts)) {
		const target = targetByHostname.get(h.hostname.toLowerCase());
		if (target) keyMap.set(k, target);
		else if (canAddHosts) {
			// A server that lets the viewer add hosts gets this one, under the file's key when it is free.
			hosts ??= structuredClone(current.deployment.hosts);
			let key = k;
			for (let n = 2; Object.hasOwn(hosts, key); n++) key = `${k}${n}`;
			hosts[key] = { hostname: h.hostname, label: h.label ?? '', bot: h.bot ?? null, ...(h.botsByOwner ? { botsByOwner: structuredClone(h.botsByOwner) } : {}) };
			keyMap.set(k, key);
			// A second key with the same host name maps to this one.
			targetByHostname.set(h.hostname.toLowerCase(), key);
			const bots = [h.bot, ...Object.values(h.botsByOwner ?? {})].filter(Boolean);
			notes.push(`Added the host ${h.hostname} (as "${key}")${bots.length ? `, with the AI-review bot${bots.length > 1 ? 's' : ''} ${bots.join(', ')}` : ''}.`);
		} else missing.push(h.hostname);
	}
	if (missing.length) notes.push(`This server has no host ${missing.join(', ')}, so the logins, repos and review teams there were left out.`);
	const mapLogins = (logins: Record<string, string>) =>
		Object.fromEntries(Object.entries(logins).flatMap(([k, v]) => (keyMap.has(k) ? [[keyMap.get(k)!, v]] : [])));

	let team: TeamMember[] = structuredClone(file.personal.team).map((m) => ({ ...m, logins: mapLogins(m.logins) }));
	const repos = structuredClone(file.personal.repos).flatMap((r) => (keyMap.has(r.host) ? [{ ...r, host: keyMap.get(r.host)! }] : []));
	const reviewTeams = Object.fromEntries(Object.entries(file.personal.reviewTeams ?? {}).flatMap(([k, v]) => (keyMap.has(k) ? [[keyMap.get(k)!, v]] : [])));

	/** Gives a member a new id, and moves the per-author policies keyed by the old one. */
	const renameMember = (m: TeamMember, to: string) => {
		const from = m.id;
		m.id = to;
		for (const r of repos) {
			if (r.pushPolicyByAuthor && Object.hasOwn(r.pushPolicyByAuthor, from)) {
				r.pushPolicyByAuthor = Object.fromEntries(Object.entries(r.pushPolicyByAuthor).map(([k, v]): [string, PushPolicy] => [k === from ? to : k, v]));
			}
		}
	};
	const freeId = (base: string) => {
		let id = `${base}-imported`;
		for (let n = 2; team.some((m) => m.id === id); n++) id = `${base}-imported-${n}`;
		return id;
	};

	// The viewer: where `me` is fixed, the file's entry that shares a login with the viewer takes the server's id. An entry that
	// only has the same id is someone else, so it gets another id; the viewer is never decided by an id alone.
	let me = file.personal.me;
	if (!editable('/personal/me')) {
		me = current.personal.me;
		const viewer = current.personal.team.find((m) => m.id === me);
		const sameLogin = (m: TeamMember) =>
			Object.entries(viewer?.logins ?? {}).some(([h, l]) => Object.hasOwn(m.logins, h) && m.logins[h]!.toLowerCase() === l.toLowerCase());
		const match = viewer ? team.find(sameLogin) : team.find((m) => m.id === me);
		const sameId = team.find((m) => m.id === me);
		if (sameId && sameId !== match) {
			const other = freeId(me);
			renameMember(sameId, other);
			notes.push(`The file's "${me}" has none of your logins, so it is someone else: it became "${other}". Check the People section.`);
		}
		if (match) {
			const old = match.id;
			if (old !== me) {
				renameMember(match, me);
				notes.push(`You are "${me}" on this server, so the file's "${old}" became "${me}".`);
			}
		} else if (viewer) {
			team = [structuredClone(viewer), ...team];
			notes.push('The file has no entry with one of your logins, so your entry on this server was kept.');
		}
	}

	const personal: PersonalSettings = {
		me,
		team,
		repos,
		reviewTeams,
		linear: file.personal.linear ?? null,
		features: { ...(file.personal.features ?? {}) },
	};

	// A field that this server does not let the viewer change keeps its value here.
	for (const key of ['team', 'repos', 'reviewTeams', 'linear', 'features'] as const) {
		if (!editable(`/personal/${key}`)) {
			(personal as unknown as Record<string, unknown>)[key] = structuredClone(current.personal[key]);
			notes.push(`This server sets ${key} itself, so the file's ${key} was not used.`);
		}
	}
	for (const f of Object.keys({ ...personal.features, ...current.personal.features }) as (keyof PersonalSettings['features'])[]) {
		if (editable(`/personal/features/${f}`)) continue;
		if (current.personal.features[f] === undefined) delete personal.features[f];
		else personal.features[f] = current.personal.features[f];
	}
	return hosts ? { personal, hosts, notes } : { personal, notes };
}
