// Fixes from the third review of the settings work: tokens per host, host key names, host order, imports. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import { problems } from './config.ts';
import { ghEnv } from './gh.ts';
import { checkSettingsPut, settingsFromConfig } from './settings.ts';
import { exportSettings, importSettings } from './settings-transfer.ts';
import type { Config, SettingsResponse } from './types.ts';

const config = (): Config => ({
	me: 'alice',
	team: [
		{ id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice-gh', ghe: 'alice-ent' } },
		{ id: 'bob', name: 'Bob', short: 'Bob', logins: { github: 'bob-gh' } },
	],
	hosts: {
		github: { hostname: 'github.com', label: 'GitHub', bot: null },
		ghe: { hostname: 'github.example.com', label: 'GHE', bot: 'review-bot', proxychains: '~/proxy.conf' },
	},
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app', pushPolicyByAuthor: { alice: 'push' } }],
	linear: null,
});

const local = (c: Config = config()): SettingsResponse => ({
	...settingsFromConfig(c),
	version: 'v1',
	mode: 'personal',
	fields: { '/personal': { editable: true }, '/personal/me': { editable: false }, '/deployment/hosts': { editable: true }, '/deployment/hosts/*/proxied': { editable: false } },
});

const withHosts = (edit: (h: SettingsResponse['deployment']['hosts']) => void, now = local()) => {
	const hosts = JSON.parse(JSON.stringify(now.deployment.hosts)) as SettingsResponse['deployment']['hosts'];
	edit(hosts);
	return checkSettingsPut(JSON.parse(JSON.stringify({ version: now.version, personal: now.personal, deployment: { hosts } })), { current: now });
};
const paths = (r: ReturnType<typeof checkSettingsPut>) => (r.ok ? [] : r.body.errors.map((e) => e.path));

describe('environment tokens go only to github.com', () => {
	const base = { GH_TOKEN: 't1', GITHUB_TOKEN: 't2', GH_ENTERPRISE_TOKEN: 't3', GH_HOST: 'other', PATH: '/bin' };

	test('github.com keeps GH_TOKEN and GITHUB_TOKEN', () => {
		const env = ghEnv('GitHub.com', base);
		expect([env.GH_TOKEN, env.GITHUB_TOKEN, env.GH_HOST, env.PATH]).toEqual(['t1', 't2', undefined, '/bin']);
	});

	test('any other host, such as github.localhost, gets neither', () => {
		for (const host of ['github.localhost', 'api.github.localhost', 'tenant.ghe.com', 'github.example.com']) {
			const env = ghEnv(host, base);
			expect([host, env.GH_TOKEN, env.GITHUB_TOKEN, env.GH_ENTERPRISE_TOKEN]).toEqual([host, undefined, undefined, 't3']);
		}
	});
});

describe('host keys and host names', () => {
	test('a host key cannot be an Object.prototype name or start with _', () => {
		for (const key of ['constructor', 'toString', '__proto__', '_private']) {
			const r = withHosts((h) => Object.defineProperty(h, key, { value: { hostname: 'x.example.com', label: 'X', bot: null }, enumerable: true }));
			expect([key, paths(r)]).toEqual([key, [`/deployment/hosts/${key}`]]);
		}
		const hand = JSON.parse(JSON.stringify(config())) as Config;
		Object.defineProperty(hand.hosts, '__proto__', { value: { hostname: 'x.example.com', label: 'X', bot: null }, enumerable: true });
		expect(problems(JSON.parse(JSON.stringify(hand)) as Config).join(' ')).toContain('host key "__proto__"');
	});

	test('a host name has no port', () => {
		expect(paths(withHosts((h) => (h.github!.hostname = 'github.localhost:8080')))).toEqual(['/deployment/hosts/github/hostname']);
	});

	test('reordering the hosts is not a change to a locked host list', () => {
		const locked = local();
		locked.fields = { ...locked.fields, '/deployment/hosts': { editable: false }, '/deployment/hosts/*/bot': { editable: true } };
		const r = withHosts((h) => {
			const { github, ...rest } = h;
			for (const k of Object.keys(h)) delete h[k];
			Object.assign(h, rest, { github });
		}, locked);
		expect(r.ok).toBe(true);
	});

	test('the settings say which hosts go through proxychains, never the path, and a new host cannot claim it', () => {
		const s = local();
		expect(s.deployment.hosts.ghe!.proxied).toBe(true);
		expect(JSON.stringify(s)).not.toContain('proxy.conf');
		expect(paths(withHosts((h) => (h.extra = { hostname: 'x.example.com', label: 'X', bot: null, proxied: true })))).toEqual(['/deployment/hosts/extra/proxied']);
	});
});

describe('importing settings', () => {
	const fileFrom = (c: Config) => JSON.parse(JSON.stringify(exportSettings(local(c)))) as unknown;

	test('an entry with your id but none of your logins is someone else', () => {
		const other = config();
		other.team = [
			{ id: 'alice', name: 'Other Alice', short: 'OA', logins: { github: 'someone-else' } },
			{ id: 'al', name: 'Alice', short: 'Alice', logins: { github: 'alice-gh' } },
		];
		other.me = 'al';
		other.repos[0]!.pushPolicyByAuthor = { alice: 'push', al: 'review-only' };
		const r = importSettings(fileFrom(other), local());
		expect(r.personal.team.map((m) => [m.id, m.logins.github])).toEqual([
			['alice-imported', 'someone-else'],
			['alice', 'alice-gh'],
		]);
		expect(r.personal.repos[0]!.pushPolicyByAuthor).toEqual({ 'alice-imported': 'push', alice: 'review-only' });
		expect(r.notes).toEqual([
			'The file\'s "alice" has none of your logins, so it is someone else: it became "alice-imported". Check the People section.',
			'You are "alice" on this server, so the file\'s "al" became "alice".',
		]);
	});

	test('a file with values of the wrong type is refused with a reason', () => {
		const file = fileFrom(config()) as { personal: { team: { name: unknown }[]; linear: unknown } };
		file.personal.team[0]!.name = 123;
		expect(() => importSettings(file, local())).toThrow('This settings file has values that Shepherd cannot use');
		const crafted = fileFrom(config()) as { personal: { me: unknown } };
		crafted.personal.me = { toString: 1 };
		expect(() => importSettings(crafted, local())).toThrow('cannot use');
	});

	test('two hosts in the file with the same host name are added once', () => {
		const file = fileFrom(config()) as { hosts: Record<string, unknown> };
		file.hosts.a = { hostname: 'git.example.org', label: 'A', bot: null };
		file.hosts.b = { hostname: 'GIT.example.org', label: 'B', bot: null };
		const r = importSettings(file, local());
		expect(Object.values(r.hosts ?? {}).filter((h) => h.hostname.toLowerCase() === 'git.example.org').length).toBe(1);
	});
});
