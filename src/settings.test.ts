// The settings model, PUT /api/settings and the config.json store. Run with `bun test`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problems } from './config.ts';
import { validate, type SchemaNode } from './schema.ts';
import { checkSettingsPut, documentFromConfig, fieldMeta, mergePersonal, settingsFromConfig } from './settings.ts';
import { createSettingsHandler, localSettings } from './settings-api.ts';
import { SETTINGS_SCHEMA, settingsSchemaJson } from './settings-schema.ts';
import { createConfigStore, SettingsConflictError, SettingsWriteError, versionOf, type StoreFs } from './settings-store.ts';
import type { Config, PersonalSettings, SettingsErrorResponse, SettingsResponse } from './types.ts';

const config = (): Config => ({
	port: 5050,
	me: 'alice',
	team: [
		{ id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice-gh' } },
		{ id: 'bob', name: 'Bob', short: 'Bob', logins: { github: 'bob-gh' }, pushPolicy: 'review-only' },
	],
	hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null, proxychains: '~/proxy.conf', reviewTeams: ['example-org/reviewers'] } },
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app', pushPolicyByAuthor: { bob: 'push' } }],
	linear: null,
});

/** The current settings of `config()`, as GET /api/settings would send them. */
const current = (c: Config = config(), extra: Partial<SettingsResponse> = {}): SettingsResponse => ({
	...settingsFromConfig(c),
	version: 'v1',
	mode: 'personal',
	fields: { '/personal': { editable: true }, '/personal/me': { editable: false, reason: 'fixed' }, '/deployment': { editable: false, reason: 'server' } },
	...extra,
});

const put = (edit: (p: PersonalSettings) => void, now: SettingsResponse = current()) => {
	const personal = structuredClone(now.personal);
	edit(personal);
	return checkSettingsPut({ version: now.version, personal }, { current: now });
};

const errorsOf = (r: ReturnType<typeof put>) => (r.ok ? [] : r.body.errors.map((e) => ({ path: e.path, code: e.code })));

describe('the schema and problems() agree', () => {
	test('dist/settings.schema.json is the schema that the server uses', () => {
		expect(JSON.parse(settingsSchemaJson())).toEqual(JSON.parse(JSON.stringify(SETTINGS_SCHEMA)));
	});

	// Each case breaks one personal field. problems() reports it at startup, and a PUT that sends the same
	// value gets the same message at the same field. The PUT is checked with the emitted JSON file, as a host would.
	const emitted = JSON.parse(settingsSchemaJson()) as SchemaNode;
	const cases: { name: string; edit: (c: Config) => void; pointer: string; message: string }[] = [
		{ name: 'an unknown push policy', edit: (c) => ((c.team[1] as { pushPolicy: string }).pushPolicy = 'force'), pointer: '/personal/team/1/pushPolicy', message: 'team[1] (bob) needs "pushPolicy" to be one of "review-only", "stacked-pr", "push", or no such field' },
		{ name: 'a login for an unknown host', edit: (c) => (c.team[0]!.logins = { gitlab: 'alice' }), pointer: '/personal/team/0/logins/gitlab', message: 'team[0] (alice) has a login for unknown host "gitlab"' },
		{ name: 'a repo on an unknown host', edit: (c) => (c.repos[0]!.host = 'gitlab'), pointer: '/personal/repos/0/host', message: 'repos[0] (example-org/app) uses unknown host "gitlab"' },
		{ name: 'a team id used twice', edit: (c) => (c.team[1]!.id = 'alice'), pointer: '/personal/team/1/id', message: 'team id "alice" is used twice' },
		{ name: 'a bad review team', edit: (c) => (c.hosts.github!.reviewTeams = ['no-slash']), pointer: '/personal/reviewTeams/github/0', message: 'hosts.github.reviewTeams must be a list of "org/team" names, or no such field' },
		{ name: 'an unknown feature', edit: (c) => (c.features = { shiped: false } as never), pointer: '/personal/features/shiped', message: '`features.shiped` is not a feature (use shipped, followups or herdr)' },
		{ name: 'allAuthors that is not true or false', edit: (c) => ((c.repos[0] as { allAuthors: unknown }).allAuthors = 'yes'), pointer: '/personal/repos/0/allAuthors', message: 'repos[0] (example-org/app) needs "allAuthors" to be true or false, or no such field' },
	];

	for (const { name, edit, pointer, message } of cases) {
		test(name, () => {
			const c = config();
			edit(c);
			expect(problems(c)).toContain(message);
			const doc = documentFromConfig(c);
			const fromFile = validate(emitted, doc).find((e) => e.pointer === pointer);
			expect(fromFile).toBeDefined();
			// A settings request sends every personal key; the config of these cases leaves out linear and features.
			const r = checkSettingsPut({ version: 'v1', personal: Object.assign({ linear: null, features: {} }, doc.personal) }, { current: current() });
			expect(r.ok).toBe(false);
			const err = !r.ok ? r.body.errors.find((e) => e.path === pointer) : undefined;
			expect(err?.code).toBe('invalid');
			// The PUT names review teams by their place in the settings, not in config.json.
			if (!pointer.startsWith('/personal/reviewTeams')) expect(err?.message).toBe(message);
		});
	}

	test('a valid config has no problems and no schema errors', () => {
		expect(problems(config())).toEqual([]);
		expect(validate(SETTINGS_SCHEMA, settingsFromConfig(config()))).toEqual([]);
	});

	test('no repos is valid: each host then finds PRs in any repo', () => {
		const doc = settingsFromConfig(config());
		doc.personal.repos = [];
		expect(validate(SETTINGS_SCHEMA, doc)).toEqual([]);
		expect(problems({ ...config(), repos: [] })).toEqual([]);
	});
});

describe('PUT /api/settings checks', () => {
	test('an unchanged copy of the settings passes', () => {
		expect(put(() => {}).ok).toBe(true);
	});

	test('valid edits pass', () => {
		const r = put((p) => {
			p.team.push({ id: 'cy', name: 'Cy', short: 'Cy', logins: { github: 'cy-gh' } });
			p.repos[0]!.allAuthors = true;
			p.repos[0]!.pushPolicy = 'stacked-pr';
			p.reviewTeams = { github: ['example-org/reviewers', 'example-org/web'] };
			p.features = { shipped: false };
			p.linear = { workspace: 'example', keys: ['EX'] };
		});
		expect(r.ok).toBe(true);
	});

	test('a body that is not a settings request is a 400', () => {
		for (const body of [null, [], 'x', { personal: {} }, { version: 'v1' }]) {
			const r = checkSettingsPut(body, { current: current() });
			expect(r.ok ? 0 : r.status).toBe(400);
		}
	});

	test('a value that breaks the schema is refused at its field', () => {
		const r = put((p) => (p.repos[0]!.owner = ''));
		expect(r.ok ? 0 : r.status).toBe(422);
		expect(errorsOf(r)).toEqual([{ path: '/personal/repos/0/owner', code: 'invalid' }]);
		expect(errorsOf(put((p) => ((p as unknown as Record<string, unknown>).port = 1)))).toEqual([{ path: '/personal/port', code: 'invalid' }]);
	});

	test('a host can refuse one field that has the right shape', () => {
		const now = current();
		const personal = structuredClone(now.personal);
		personal.repos.push({ host: 'github', owner: 'example-org', name: 'secret', short: 'secret' });
		const r = checkSettingsPut(
			{ version: now.version, personal },
			{
				current: now,
				refuse: (next) =>
					next.repos.flatMap((repo, i) => (repo.name === 'secret' ? [{ path: `/personal/repos/${i}`, code: 'refused' as const, message: "You can't watch example-org/secret." }] : [])),
			}
		);
		expect(r.ok ? 0 : r.status).toBe(422);
		expect(!r.ok && r.body.errors).toEqual([{ path: '/personal/repos/1', code: 'refused', message: "You can't watch example-org/secret." }]);
	});

	test('the cost limits refuse too many people or repos', () => {
		const c = { ...config(), limits: { maxPeople: 2, maxRepos: 1 } };
		const now = current(c);
		const r = put((p) => {
			p.team.push({ id: 'cy', name: 'Cy', short: 'Cy', logins: { github: 'cy-gh' } });
			p.repos.push({ host: 'github', owner: 'example-org', name: 'web', short: 'web' });
		}, now);
		expect(errorsOf(r)).toEqual([
			{ path: '/personal/team', code: 'limit' },
			{ path: '/personal/repos', code: 'limit' },
		]);
	});

	test('an old version is a conflict, with the current settings', () => {
		const now = current();
		const r = checkSettingsPut({ version: 'v0', personal: now.personal }, { current: now });
		expect(r.ok ? 0 : r.status).toBe(409);
		expect(!r.ok && r.body.settings?.version).toBe('v1');
	});

	test('fields that are not editable are refused even when sent', () => {
		expect(errorsOf(put((p) => (p.me = 'bob')))).toEqual([{ path: '/personal/me', code: 'not_editable' }]);
		const now = current();
		const r = checkSettingsPut({ version: now.version, personal: now.personal, deployment: { ...now.deployment, refresh: 'list' } }, { current: now });
		expect(errorsOf(r)).toEqual([{ path: '/deployment/refresh', code: 'not_editable' }]);
		// A host marks a feature that it does not have as not editable.
		const noHerdr = current(config(), { fields: { ...current().fields, '/personal/features/herdr': { editable: false, reason: 'no herdr here' } } });
		expect(errorsOf(put((p) => (p.features = { herdr: true }), noHerdr))).toEqual([{ path: '/personal/features/herdr', code: 'not_editable' }]);
		expect(put((p) => (p.features = { shipped: false }), noHerdr).ok).toBe(true);
	});

	test("you can set anyone's push policy, in the team and per repo", () => {
		expect(put((p) => (p.team[1]!.pushPolicy = 'push')).ok).toBe(true);
		expect(put((p) => delete p.team[1]!.pushPolicy).ok).toBe(true);
		expect(put((p) => p.team.push({ id: 'cy', name: 'Cy', short: 'Cy', logins: { github: 'cy' }, pushPolicy: 'stacked-pr' })).ok).toBe(true);
		expect(put((p) => (p.repos[0]!.pushPolicyByAuthor = { bob: 'review-only', 'outside-login': 'stacked-pr' })).ok).toBe(true);
		expect(put((p) => delete p.repos[0]!.pushPolicyByAuthor).ok).toBe(true);
		expect(put((p) => (p.repos[0]!.pushPolicy = 'review-only')).ok).toBe(true);
	});

	test('a per-author entry needs a key and a known policy', () => {
		expect(errorsOf(put((p) => (p.repos[0]!.pushPolicyByAuthor = { '': 'push' })))).toEqual([{ path: '/personal/repos/0/pushPolicyByAuthor/', code: 'invalid' }]);
		expect(errorsOf(put((p) => (p.repos[0]!.pushPolicyByAuthor = { bob: 'force' as never })))).toEqual([{ path: '/personal/repos/0/pushPolicyByAuthor/bob', code: 'invalid' }]);
	});

	test('a host can lock push policies with fields', () => {
		const locked = current(config(), {
			fields: { ...current().fields, '/personal/team/*/pushPolicy': { editable: false, reason: 'Each person sets their own.' }, '/personal/repos/*/pushPolicyByAuthor': { editable: false } },
		});
		expect(errorsOf(put((p) => (p.team[1]!.pushPolicy = 'push'), locked))).toEqual([{ path: '/personal/team/1/pushPolicy', code: 'not_editable' }]);
		expect(errorsOf(put((p) => (p.repos[0]!.pushPolicyByAuthor = {}), locked))).toEqual([{ path: '/personal/repos/0/pushPolicyByAuthor', code: 'not_editable' }]);
		expect(put((p) => (p.team[0]!.name = 'Alice B.'), locked).ok).toBe(true);
	});
});

describe('field metadata', () => {
	test('the longest matching pointer wins, and * matches any item', () => {
		const fields = { '/personal': { editable: true }, '/personal/team/*/logins': { editable: false, reason: 'from the directory' }, '/deployment': { editable: false } };
		expect(fieldMeta(fields, '/personal/team/3/logins/github')).toEqual({ editable: false, reason: 'from the directory' });
		expect(fieldMeta(fields, '/personal/team/3/name')).toEqual({ editable: true });
		expect(fieldMeta(fields, '/deployment/hosts/github')).toEqual({ editable: false });
		expect(fieldMeta({}, '/personal/repos')).toEqual({ editable: true });
		expect(fieldMeta({}, '/deployment/limits')).toEqual({ editable: false });
	});
});

describe('config.json write-back', () => {
	test('personal settings go in; keys the API never sends stay', () => {
		const onDisk = config() as unknown as Record<string, unknown>;
		const personal = settingsFromConfig(config()).personal;
		personal.reviewTeams = {};
		personal.team[0]!.name = 'Alice Example';
		const out = mergePersonal(onDisk, personal) as unknown as Config;
		expect(out.port).toBe(5050);
		expect(out.hosts.github!.proxychains).toBe('~/proxy.conf');
		expect(out.hosts.github!.reviewTeams).toBeUndefined();
		expect(out.team[0]!.name).toBe('Alice Example');
		expect('features' in out).toBe(false);
	});
});

describe('the config.json store', () => {
	let dir: string;
	let file: string;
	const write = (c: unknown) => writeFile(file, `${JSON.stringify(c, null, 2)}\n`);
	const open = async (fs?: StoreFs) => {
		const text = await readFile(file, 'utf8');
		return createConfigStore(file, text, JSON.parse(text) as Config, { minRefreshMs: 0, ...(fs ? { fs } : {}) });
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'shepherd-settings-'));
		file = join(dir, 'config.json');
		await write(config());
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	test('a save writes the file and changes the version', async () => {
		const store = await open();
		const before = store.version;
		const personal = settingsFromConfig(store.config).personal;
		personal.repos[0]!.allAuthors = true;
		let seen: Config | undefined;
		store.onChange((c) => (seen = c));
		await store.save(personal, before);
		const onDisk = JSON.parse(await readFile(file, 'utf8')) as Config;
		expect(onDisk.repos[0]!.allAuthors).toBe(true);
		expect(onDisk.hosts.github!.proxychains).toBe('~/proxy.conf');
		expect(store.version).toBe(versionOf(await readFile(file, 'utf8')));
		expect(store.version).not.toBe(before);
		expect(seen?.repos[0]!.allAuthors).toBe(true);
	});

	test('a failed write keeps the old file and leaves no temp file', async () => {
		const original = await readFile(file, 'utf8');
		const fs: StoreFs = {
			readFile: (p) => readFile(p, 'utf8'),
			writeFile: (p, t) => writeFile(p, t),
			rename: () => Promise.reject(new Error('disk full')),
			rm: (p) => rm(p, { force: true }),
		};
		const store = await open(fs);
		const personal = settingsFromConfig(store.config).personal;
		personal.team[0]!.name = 'Changed';
		await expect(store.save(personal, store.version)).rejects.toBeInstanceOf(SettingsWriteError);
		expect(await readFile(file, 'utf8')).toBe(original);
		expect(await readdir(dir)).toEqual(['config.json']);
		expect(store.config.team[0]!.name).toBe('Alice');
	});

	test('a file changed on disk is a conflict, and the store loads the new file', async () => {
		const store = await open();
		const loadedAt = store.version;
		const edited = config();
		edited.team[1]!.name = 'Bob Edited';
		await write(edited);
		await expect(store.save(settingsFromConfig(store.config).personal, loadedAt)).rejects.toBeInstanceOf(SettingsConflictError);
		expect(store.config.team[1]!.name).toBe('Bob Edited');
		expect(store.version).not.toBe(loadedAt);
	});

	test('a hand edit reloads without a restart; a broken one keeps the last good config', async () => {
		const store = await open();
		const edited = config();
		edited.repos.push({ host: 'github', owner: 'example-org', name: 'web', short: 'web' });
		await write(edited);
		expect(await store.refresh()).toBe(true);
		expect(store.config.repos).toHaveLength(2);
		await writeFile(file, '{ not json');
		expect(await store.refresh()).toBe(false);
		expect(store.config.repos).toHaveLength(2);
		expect(store.problems[0]).toContain('not valid JSON');
		await write({ ...edited, me: 'nobody' });
		await store.refresh();
		expect(store.problems).toEqual(['`me` must be one of the team ids (alice, bob)']);
		expect(store.config.me).toBe('alice');
	});

	test('a reload applies the hosts at once, and keeps the other deployment settings from startup', async () => {
		const store = await open();
		const edited = config();
		edited.hosts.github!.concurrency = 8;
		edited.hosts.github!.reviewTeams = ['example-org/web'];
		edited.refresh = 'list';
		await write(edited);
		await store.refresh();
		expect(store.config.hosts.github!.concurrency).toBe(8);
		expect(store.config.hosts.github!.reviewTeams).toEqual(['example-org/web']);
		expect(store.config.refresh).toBeUndefined();
		expect(store.problems).toEqual(['config.json changed refresh; restart the server to apply it']);
	});

	describe('the HTTP handler', () => {
		const handler = async () => createSettingsHandler(await open(), { sameOrigin: (req) => !req.headers.get('origin') });
		const req = (method: string, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
			new Request('http://127.0.0.1/api/settings', { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

		test('GET sends the values, the editable flags and the limits', async () => {
			const res = await (await handler())(req('GET'));
			const body = (await res.json()) as SettingsResponse;
			expect(res.status).toBe(200);
			expect(body.mode).toBe('personal');
			expect(body.personal.reviewTeams).toEqual({ github: ['example-org/reviewers'] });
			expect(body.deployment.limits).toEqual({});
			expect(JSON.stringify(body)).not.toContain('proxy.conf');
			expect(body.fields['/deployment/hosts']?.editable).toBe(true);
			expect(body.fields['/deployment/hosts/*/concurrency']?.editable).toBe(false);
			expect(body.fields['/deployment/limits']?.editable).toBe(false);
		});

		test('PUT saves, and a second PUT from the same copy is a conflict', async () => {
			const handle = await handler();
			const got = (await (await handle(req('GET'))).json()) as SettingsResponse;
			const personal = structuredClone(got.personal);
			personal.repos[0]!.short = 'the-app';
			const saved = await handle(req('PUT', { version: got.version, personal }));
			expect(saved.status).toBe(200);
			expect(((await saved.json()) as SettingsResponse).personal.repos[0]!.short).toBe('the-app');
			const again = await handle(req('PUT', { version: got.version, personal }));
			expect(again.status).toBe(409);
			expect(((await again.json()) as SettingsErrorResponse).settings?.personal.repos[0]!.short).toBe('the-app');
		});

		test('PUT returns per-field errors, and refuses other origins and other content types', async () => {
			const handle = await handler();
			const got = (await (await handle(req('GET'))).json()) as SettingsResponse;
			const bad = await handle(req('PUT', { version: got.version, personal: { ...got.personal, repos: [{ host: 'github', owner: '', name: 'app', short: 'app' }] } }));
			expect(bad.status).toBe(422);
			expect(((await bad.json()) as SettingsErrorResponse).errors).toEqual([{ path: '/personal/repos/0/owner', code: 'invalid', message: 'repos[0] needs owner, name and short' }]);
			expect((await handle(req('PUT', { version: got.version, personal: got.personal }, { 'content-type': 'application/json', origin: 'https://evil.example' }))).status).toBe(403);
			expect((await handle(req('PUT', { version: got.version, personal: got.personal }, { 'content-type': 'text/plain' }))).status).toBe(415);
		});

		test('herdr turned off on the server is not editable', async () => {
			await write({ ...config(), herdr: { enabled: false } });
			const settings = localSettings(await open());
			expect(settings.fields['/personal/features/herdr']?.editable).toBe(false);
		});
	});
});
