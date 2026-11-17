// Locks, request shape, schema hardening, hosts in a settings request, per-repo AI-review bots and safe writes.
// Run with `bun test`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { problems } from './config.ts';
import { linearKeyRegExp } from './linear.ts';
import { allReviewBots, reviewBot } from './review-bot.ts';
import { checkSettingsPut, settingsFromConfig } from './settings.ts';
import { createSettingsHandler, localSettings } from './settings-api.ts';
import { createConfigStore } from './settings-store.ts';
import type { Config, PersonalSettings, SettingsResponse } from './types.ts';

const config = (): Config => ({
	port: 5050,
	me: 'alice',
	team: [
		{ id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice-gh' } },
		{ id: 'bob', name: 'Bob', short: 'Bob', logins: { github: 'bob-gh' }, pushPolicy: 'review-only' },
	],
	hosts: {
		github: { hostname: 'github.com', label: 'GitHub', bot: null, proxychains: '~/proxy.conf', reviewTeams: ['example-org/reviewers'] },
		ghe: { hostname: 'github.example.com', label: 'GHE', bot: 'review-bot', concurrency: 2 },
	},
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app', pushPolicyByAuthor: { bob: 'push' } }],
	linear: null,
});

const current = (c: Config = config(), extra: Partial<SettingsResponse> = {}): SettingsResponse => ({
	...settingsFromConfig(c),
	version: 'v1',
	mode: 'personal',
	fields: { '/personal': { editable: true }, '/personal/me': { editable: false, reason: 'fixed' }, '/deployment': { editable: false, reason: 'server' } },
	...extra,
});

type Body = { version: string; personal: unknown; deployment?: unknown };
const send = (body: Body, now: SettingsResponse = current()) => checkSettingsPut(body, { current: now });
const put = (edit: (p: PersonalSettings) => void, now: SettingsResponse = current()) => {
	const personal = structuredClone(now.personal);
	edit(personal);
	return send({ version: now.version, personal }, now);
};
const errorsOf = (r: ReturnType<typeof send>) => (r.ok ? [] : r.body.errors.map((e) => ({ path: e.path, code: e.code })));

describe('locks with * compare each item', () => {
	const locked = current(config(), {
		fields: { ...current().fields, '/personal/team/*/pushPolicy': { editable: false, reason: 'Each person sets their own.' } },
	});

	test('moving a policy to another person is a change', () => {
		const r = put((p) => {
			delete p.team[1]!.pushPolicy;
			p.team[0]!.pushPolicy = 'review-only';
		}, locked);
		expect(errorsOf(r)).toEqual([
			{ path: '/personal/team/0/pushPolicy', code: 'not_editable' },
			{ path: '/personal/team/1/pushPolicy', code: 'not_editable' },
		]);
	});

	test('a new person with the same policy as a removed one is a change', () => {
		const r = put((p) => {
			p.team.splice(1, 1);
			p.team.push({ id: 'cy', name: 'Cy', short: 'Cy', logins: { github: 'cy' }, pushPolicy: 'review-only' });
		}, locked);
		expect(errorsOf(r)).toEqual([{ path: '/personal/team/1/pushPolicy', code: 'not_editable' }]);
	});

	test('reordering the team, or removing a person, is not a change to a policy', () => {
		expect(put((p) => p.team.reverse(), locked).ok).toBe(true);
		expect(put((p) => p.team.splice(1, 1), locked).ok).toBe(true);
	});

	test('the longest matching pointer wins, as in the panel', () => {
		const teamLocked = current(config(), {
			fields: { ...current().fields, '/personal/team': { editable: false, reason: 'The host sets the team.' }, '/personal/team/*/pushPolicy': { editable: true } },
		});
		expect(put((p) => (p.team[1]!.pushPolicy = 'push'), teamLocked).ok).toBe(true);
		expect(errorsOf(put((p) => (p.team[1]!.name = 'Robert'), teamLocked))).toEqual([{ path: '/personal/team', code: 'not_editable' }]);
	});
});

describe('the shape of a settings request', () => {
	test('every personal key must be sent, so that none is deleted by leaving it out', () => {
		const { linear: _l, features: _f, ...partial } = current().personal;
		expect(errorsOf(send({ version: 'v1', personal: partial }))).toEqual([
			{ path: '/personal/linear', code: 'invalid' },
			{ path: '/personal/features', code: 'invalid' },
		]);
	});

	test('keys named like Object.prototype members are not settings', () => {
		const personal = JSON.parse(JSON.stringify({ ...current().personal, constructor: { x: 1 } })) as Record<string, unknown>;
		expect(errorsOf(send({ version: 'v1', personal }))).toEqual([{ path: '/personal/constructor', code: 'invalid' }]);
		const proto = JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(current().personal).slice(1)}`) as Record<string, unknown>;
		expect(errorsOf(send({ version: 'v1', personal: proto }))).toEqual([{ path: '/personal/__proto__', code: 'invalid' }]);
	});

	test('a value that cannot be turned into text still gets a message', () => {
		const r = put((p) => ((p as unknown as Record<string, unknown>).me = { toString: 1 }));
		expect(r.ok).toBe(false);
		expect(!r.ok && r.body.errors[0]?.message).toContain('`me` must be one of the team ids');
		expect(() => problems({ ...config(), me: { toString: 1 } as never })).not.toThrow();
	});

	test('unknown keys in a person, a repo or linear are refused', () => {
		expect(errorsOf(put((p) => ((p.team[0] as unknown as Record<string, unknown>).role = 'admin')))).toEqual([{ path: '/personal/team/0/role', code: 'invalid' }]);
		expect(errorsOf(put((p) => ((p.repos[0] as unknown as Record<string, unknown>).token = 'x')))).toEqual([{ path: '/personal/repos/0/token', code: 'invalid' }]);
		expect(errorsOf(put((p) => (p.linear = { workspace: 'acme', keys: ['ENG'], extra: 1 } as never)))).toEqual([{ path: '/personal/linear/extra', code: 'invalid' }]);
	});

	test('per-author keys must be a login or a team id, so markup never gets in', () => {
		expect(errorsOf(put((p) => (p.repos[0]!.pushPolicyByAuthor = { 'x"><img src=x>': 'push' })))).toEqual([
			{ path: '/personal/repos/0/pushPolicyByAuthor/x"><img src=x>', code: 'invalid' },
		]);
		expect(put((p) => (p.repos[0]!.pushPolicyByAuthor = { 'ci-helper[bot]': 'review-only', 'outside.login': 'push' })).ok).toBe(true);
	});

	test('Linear team keys are letters and digits only', () => {
		expect(errorsOf(put((p) => (p.linear = { workspace: 'acme', keys: ['ENG', 'OPS('] })))).toEqual([{ path: '/personal/linear/keys/1', code: 'invalid' }]);
		expect(put((p) => (p.linear = { workspace: 'acme', keys: ['ENG', 'OPS2'] })).ok).toBe(true);
	});
});

describe('Linear keys in text', () => {
	test('a key is matched as plain text, so a stray character never breaks the pattern', () => {
		const re = linearKeyRegExp(['ENG', 'OPS(', '(a+)+']);
		expect([...'fixes ENG-12 and OPS(-3, not aaaa-1'.matchAll(re!)].map((m) => m[0])).toEqual(['ENG-12', 'OPS(-3']);
		expect(linearKeyRegExp([])).toBeNull();
	});
});

describe('AI-review bots per owner', () => {
	const c = {
		hosts: {
			github: { bot: 'host-bot', botsByOwner: { 'Org-A': 'org-a-bot', 'org-b': null } },
			ghe: { bot: null },
		},
	};

	test("an owner's bot wins, null turns it off, and other owners get the host's", () => {
		expect(reviewBot(c, 'github', 'org-a')).toBe('org-a-bot');
		expect(reviewBot(c, 'github', 'org-b')).toBeNull();
		expect(reviewBot(c, 'github', 'org-c')).toBe('host-bot');
		expect(reviewBot(c, 'ghe', 'org-a')).toBeNull();
		expect(reviewBot(c, 'gitlab', 'org-a')).toBeNull();
	});

	test('every bot login, for leaving bots out of participants', () => {
		expect(allReviewBots(c).sort()).toEqual(['host-bot', 'org-a-bot']);
	});
});

describe('hosts in a settings request', () => {
	const hostsEditable = current(config(), {
		fields: {
			'/personal': { editable: true },
			'/personal/me': { editable: false },
			'/deployment/hosts': { editable: true },
			'/deployment/hosts/*/concurrency': { editable: false, reason: 'file only' },
			'/deployment/refresh': { editable: false },
		},
	});
	const withHosts = (edit: (h: SettingsResponse['deployment']['hosts']) => void, now = hostsEditable) => {
		const hosts = structuredClone(now.deployment.hosts);
		edit(hosts);
		return send({ version: 'v1', personal: now.personal, deployment: { hosts } }, now);
	};

	test('a host can be added, renamed and given a bot', () => {
		const r = withHosts((h) => {
			h.gitlabish = { hostname: 'git.example.org', label: 'Example', bot: 'example-bot' };
			h.ghe!.hostname = 'github.example.net';
			h.github!.bot = 'org-bot';
		});
		expect(r.ok).toBe(true);
		expect(r.ok && r.deployment.hosts.gitlabish).toEqual({ hostname: 'git.example.org', label: 'Example', bot: 'example-bot' });
		expect(r.ok && r.deployment.hosts.ghe).toEqual({ hostname: 'github.example.net', label: 'GHE', bot: 'review-bot', concurrency: 2 });
	});

	test('a host can give owners their own bot', () => {
		const r = withHosts((h) => (h.github!.botsByOwner = { 'other-org': 'other-bot', 'quiet-org': null }));
		expect(r.ok && r.deployment.hosts.github!.botsByOwner).toEqual({ 'other-org': 'other-bot', 'quiet-org': null });
		expect(errorsOf(withHosts((h) => (h.github!.botsByOwner = { 'not an org': 'x' })))).toEqual([{ path: '/deployment/hosts/github/botsByOwner/not an org', code: 'invalid' }]);
		expect(errorsOf(withHosts((h) => (h.github!.botsByOwner = { 'other-org': 'not a login' })))).toEqual([{ path: '/deployment/hosts/github/botsByOwner/other-org', code: 'invalid' }]);
	});

	test('fields that start processes or set limits stay as they are', () => {
		expect(errorsOf(withHosts((h) => (h.ghe!.concurrency = 9)))).toEqual([{ path: '/deployment/hosts/ghe/concurrency', code: 'not_editable' }]);
		expect(errorsOf(withHosts((h) => (h.new = { hostname: 'x.example.com', label: 'X', bot: null, concurrency: 1 } as never)))).toEqual([
			{ path: '/deployment/hosts/new/concurrency', code: 'not_editable' },
		]);
		const r = send({ version: 'v1', personal: hostsEditable.personal, deployment: { ...hostsEditable.deployment, refresh: 'list' } }, hostsEditable);
		expect(errorsOf(r)).toEqual([{ path: '/deployment/refresh', code: 'not_editable' }]);
	});

	test('host names and keys are checked, and a host in use cannot go', () => {
		expect(errorsOf(withHosts((h) => (h.ghe!.hostname = '--help')))).toEqual([{ path: '/deployment/hosts/ghe/hostname', code: 'invalid' }]);
		expect(errorsOf(withHosts((h) => (h['a/b'] = { hostname: 'x.example.com', label: 'X', bot: null })))).toEqual([{ path: '/deployment/hosts/a~1b', code: 'invalid' }]);
		const gone = withHosts((h) => delete h.github);
		expect(gone.ok).toBe(false);
		expect(errorsOf(gone).every((e) => e.code === 'invalid')).toBe(true);
	});

	test('a host that locks the deployment refuses any change to the hosts', () => {
		expect(errorsOf(withHosts((h) => (h.github!.bot = 'org-bot'), current()))).toEqual([{ path: '/deployment', code: 'not_editable' }]);
	});
});

describe('the local server and its config.json', () => {
	let dir: string;
	let file: string;
	const write = (c: unknown, to = file) => writeFile(to, `${JSON.stringify(c, null, 2)}\n`);
	const open = async () => {
		const text = await readFile(file, 'utf8');
		return createConfigStore(file, text, JSON.parse(text) as Config, { minRefreshMs: 0 });
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'shepherd-hardening-'));
		file = join(dir, 'config.json');
		await write(config());
	});
	afterEach(() => rm(dir, { recursive: true, force: true }));

	test('a save keeps the file mode and a symlink', async () => {
		const real = join(dir, 'real.json');
		await write(config(), real);
		await chmod(real, 0o600);
		await rm(file);
		await symlink(real, file);
		const store = await open();
		const personal = settingsFromConfig(store.config).personal;
		personal.team[0]!.name = 'Alice B.';
		await store.save(personal, store.version);
		expect((await lstat(file)).isSymbolicLink()).toBe(true);
		expect((await stat(real)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(real, 'utf8')).team[0].name).toBe('Alice B.');
	});

	test('hosts from a save keep their file-only fields, and a new host gets its review teams', async () => {
		const store = await open();
		const { personal, deployment } = settingsFromConfig(store.config);
		deployment.hosts.extra = { hostname: 'git.example.org', label: 'Extra', bot: 'extra-bot' };
		deployment.hosts.ghe!.bot = 'new-bot';
		deployment.hosts.ghe!.botsByOwner = { 'other-org': 'other-bot' };
		personal.reviewTeams.extra = ['example-org/extra'];
		await store.save(personal, store.version, deployment.hosts);
		const saved = JSON.parse(await readFile(file, 'utf8')) as Config;
		expect(saved.hosts.github).toEqual({ hostname: 'github.com', label: 'GitHub', bot: null, proxychains: '~/proxy.conf', reviewTeams: ['example-org/reviewers'] });
		expect(saved.hosts.ghe).toEqual({ hostname: 'github.example.com', label: 'GHE', bot: 'new-bot', concurrency: 2, botsByOwner: { 'other-org': 'other-bot' } });
		expect(saved.hosts.extra).toEqual({ hostname: 'git.example.org', label: 'Extra', bot: 'extra-bot', reviewTeams: ['example-org/extra'] });
		// Hosts apply at once.
		expect(store.config.hosts.extra?.hostname).toBe('git.example.org');
		expect(store.problems).toEqual([]);
	});

	test('the problems of a broken edit go away when the file is back as it was', async () => {
		const store = await open();
		const good = await readFile(file, 'utf8');
		await writeFile(file, '{ not json');
		await store.refresh();
		expect(store.problems.length).toBe(1);
		await writeFile(file, good);
		await store.refresh();
		expect(store.problems).toEqual([]);
	});

	test('with an enterprise token in the environment, host names and the list of hosts are locked', async () => {
		const store = await open();
		const now = localSettings(store, { GH_ENTERPRISE_TOKEN: 'secret' });
		const hosts = structuredClone(now.deployment.hosts);
		hosts.ghe!.hostname = 'attacker.example.com';
		expect(errorsOf(send({ version: now.version, personal: now.personal, deployment: { hosts } }, now))).toEqual([
			{ path: '/deployment/hosts', code: 'not_editable' },
		]);
		const relabeled = structuredClone(now.deployment.hosts);
		relabeled.ghe!.label = 'Enterprise';
		relabeled.ghe!.bot = 'other-bot';
		expect(send({ version: now.version, personal: now.personal, deployment: { hosts: relabeled } }, now).ok).toBe(true);
		const added = structuredClone(now.deployment.hosts);
		added.more = { hostname: 'more.example.com', label: 'More', bot: null };
		expect(errorsOf(send({ version: now.version, personal: now.personal, deployment: { hosts: added } }, now))).toEqual([
			{ path: '/deployment/hosts', code: 'not_editable' },
		]);
		expect(localSettings(store, {}).fields['/deployment/hosts']?.editable).toBe(true);
	});

	test('the settings endpoint answers a preflight with no CORS headers', async () => {
		const handle = createSettingsHandler(await open(), { sameOrigin: () => true });
		const res = await handle(new Request('http://127.0.0.1/api/settings', { method: 'OPTIONS', headers: { origin: 'http://evil.example' } }));
		expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
	});
});
