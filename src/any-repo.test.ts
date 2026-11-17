// Hosts in any-repo mode: the team's PRs in any repo of some orgs, set per host (`anyRepo`) or, for a host with no
// listed repos, by the server (`defaultOrgs`). Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import { problems, publicConfig } from './config.ts';
import type { GhRunner } from './gh.ts';
import { createPrService } from './prs.ts';
import { findListed, newRepoEntry, unlistedRepos } from './repo-chips.ts';
import { anyRepoAfterAdding, defaultScope, inScope, scopeQualifiers, searchHostKeys } from './repo-scope.ts';
import { checkSettingsPut, mergePersonal, settingsFromConfig } from './settings.ts';
import { localSettings } from './settings-api.ts';
import { exportSettings, importSettings } from './settings-transfer.ts';
import type { ConfigStore } from './settings-store.ts';
import type { AnyRepoScope, Config, HostConfig, PersonalSettings, RepoConfig, SettingsResponse } from './types.ts';

const app: RepoConfig = { host: 'github', owner: 'example-org', name: 'app', short: 'app' };
const outside: RepoConfig = { host: 'github', owner: 'partner-org', name: 'lib', short: 'lib' };
const open: RepoConfig = { host: 'github', owner: 'example-org', name: 'open', short: 'open', allAuthors: true };
const ghe: HostConfig = { hostname: 'github.example.com', label: 'GHE', bot: null };

const config = (repos: RepoConfig[], anyRepo?: AnyRepoScope, more: Record<string, HostConfig> = {}, github: Partial<HostConfig> = {}): Config => ({
	me: 'alice',
	team: [{ id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice' } }],
	hosts: {
		github: { hostname: 'github.com', label: 'GitHub', bot: null, reviewTeams: ['example-org/reviewers'], ...(anyRepo ? { anyRepo } : {}), ...github },
		...more,
	},
	repos,
});

function service(c: Config) {
	const queries: string[] = [];
	const gh: GhRunner = {
		rate: {},
		get: () => Promise.reject(new Error('not used')),
		query: async <T>(_host: string, _q: string, vars?: Record<string, unknown>) => {
			queries.push(String(vars?.q));
			return { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } as T;
		},
	};
	return { prs: createPrService(c, gh), queries };
}

describe('scope helpers', () => {
	test('listed mode names the listed repos', () => {
		expect(scopeQualifiers(config([app]), 'github')).toBe('repo:example-org/app');
	});

	test('any repo names the orgs, plus listed repos outside them (GitHub ORs repo: and org:)', () => {
		expect(scopeQualifiers(config([app, outside], { orgs: ['example-org'] }), 'github')).toBe('org:example-org repo:partner-org/lib');
		expect(scopeQualifiers(config([], { orgs: ['example-org', 'other-org'] }), 'github')).toBe('org:example-org org:other-org');
	});

	test('there is no "every repo on the host": an empty org list is listed mode', () => {
		const c = config([app], { orgs: [] });
		expect(scopeQualifiers(c, 'github')).toBe('repo:example-org/app');
		expect(inScope(c, 'github', 'anyone', 'anything')).toBe(false);
	});

	test('a host with no listed repos searches its defaultOrgs, when the team has a login there', () => {
		const c = config([app], undefined, { ghe: { ...ghe, defaultOrgs: ['example-org'] } });
		// Nobody has a login on ghe, so it is not searched at all.
		expect(scopeQualifiers(c, 'ghe')).toBeNull();
		expect(searchHostKeys(c)).toEqual(['github']);
		c.team[0]!.logins.ghe = 'alice-ent';
		expect(defaultScope(c, 'ghe')).toEqual(['example-org']);
		expect(scopeQualifiers(c, 'ghe')).toBe('org:example-org');
		expect(searchHostKeys(c).sort()).toEqual(['ghe', 'github']);
		expect(inScope(c, 'ghe', 'Example-Org', 'anything')).toBe(true);
		expect(inScope(c, 'ghe', 'anyone', 'anything')).toBe(false);
		// The person's own setting wins over the server's defaults.
		c.hosts.ghe = { ...c.hosts.ghe!, anyRepo: { orgs: ['other-org'] } };
		expect(scopeQualifiers(c, 'ghe')).toBe('org:other-org');
		expect(publicConfig(c).hosts.ghe?.anyRepo).toEqual({ orgs: ['other-org'] });
	});

	test('a host with no listed repos and no defaultOrgs is not searched', () => {
		const c = config([], undefined);
		expect(scopeQualifiers(c, 'github')).toBeNull();
		expect(searchHostKeys(c)).toEqual([]);
		expect(publicConfig(c).hosts.github?.anyRepo).toBeUndefined();
		// With listed repos, the defaults do not apply.
		expect(scopeQualifiers(config([app], undefined, {}, { defaultOrgs: ['example-org'] }), 'github')).toBe('repo:example-org/app');
	});

	test('inScope: listed repos and the org list, without case', () => {
		expect(inScope(config([app]), 'github', 'example-org', 'other')).toBe(false);
		expect(inScope(config([app]), 'github', 'Example-Org', 'APP')).toBe(true);
		const orgs = config([outside], { orgs: ['example-org'] });
		expect(inScope(orgs, 'github', 'EXAMPLE-ORG', 'new')).toBe(true);
		expect(inScope(orgs, 'github', 'partner-org', 'lib')).toBe(true);
		expect(inScope(orgs, 'github', 'partner-org', 'other')).toBe(false);
		expect(inScope(orgs, 'ghe', 'example-org', 'new')).toBe(false);
	});
});

describe('listHost and listMerged in any-repo mode', () => {
	test('listed mode searches as before', async () => {
		const { prs, queries } = service(config([app]));
		await prs.listHost('github', ['alice']);
		expect(queries.sort()).toEqual([
			'is:pr is:open draft:false repo:example-org/app team-review-requested:example-org/reviewers',
			'is:pr is:open repo:example-org/app author:alice',
			'is:pr is:open repo:example-org/app user-review-requested:alice',
		]);
	});

	test('the org list limits every search to the orgs and the listed repos outside them', async () => {
		const { prs, queries } = service(config([app, outside], { orgs: ['example-org'] }));
		await prs.listHost('github', ['alice']);
		expect(queries.sort()).toEqual([
			'is:pr is:open draft:false org:example-org repo:partner-org/lib team-review-requested:example-org/reviewers',
			'is:pr is:open org:example-org repo:partner-org/lib author:alice',
			'is:pr is:open org:example-org repo:partner-org/lib user-review-requested:alice',
		]);
	});

	test('allAuthors repos keep their own search', async () => {
		const { prs, queries } = service(config([open], { orgs: ['example-org'] }));
		await prs.listHost('github', []);
		expect(queries.sort()).toEqual([
			'is:pr is:open draft:false org:example-org team-review-requested:example-org/reviewers',
			'is:pr is:open org:example-org author:alice',
			'is:pr is:open repo:example-org/open',
		]);
	});

	test('Shipped searches the orgs too', async () => {
		const { prs, queries } = service(config([], { orgs: ['example-org'] }));
		await prs.listMerged('github');
		expect(queries).toHaveLength(1);
		expect(queries[0]).toMatch(/^is:pr is:merged merged:>=\S+ org:example-org author:alice sort:updated-desc$/);
	});
});

describe('settings', () => {
	test('config.json keeps anyRepo under hosts; the settings have it under personal', () => {
		const c = config([], { orgs: ['example-org'] });
		expect(problems(c)).toEqual([]);
		const s = settingsFromConfig(c);
		expect(s.personal.anyRepo).toEqual({ github: { orgs: ['example-org'] } });
		expect('anyRepo' in s.deployment.hosts.github!).toBe(false);
		expect(settingsFromConfig(config([app])).personal.anyRepo).toEqual({});
	});

	test('anyRepo needs at least one org', () => {
		expect(problems(config([app], { orgs: [] }))).toEqual(['hosts.github.anyRepo.orgs needs at least one org: any repo means any repo in these orgs']);
		expect(problems(config([app], {} as AnyRepoScope))).toEqual(['hosts.github.anyRepo.orgs needs at least one org: any repo means any repo in these orgs']);
		expect(problems(config([app], { orgs: ['not an org'] }))).toEqual(['hosts.github.anyRepo.orgs must be a list of org or user names, such as example-org']);
	});

	test('defaultOrgs is a server setting: in the deployment settings, and not editable in the panel', () => {
		const c = config([], undefined, {}, { defaultOrgs: ['example-org', 'other-org'] });
		expect(problems(c)).toEqual([]);
		const store = { config: c, version: 'v1', problems: [] } as unknown as ConfigStore;
		const s = localSettings(store, {});
		expect(s.deployment.hosts.github?.defaultOrgs).toEqual(['example-org', 'other-org']);
		expect(s.fields['/deployment/hosts/*/defaultOrgs']?.editable).toBe(false);
		const hosts = structuredClone(s.deployment.hosts);
		hosts.github!.defaultOrgs = ['example-org'];
		const r = checkSettingsPut({ version: 'v1', personal: s.personal, deployment: { hosts } }, { current: s });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.body.errors.map((e) => e.path)).toEqual(['/deployment/hosts/github/defaultOrgs']);
	});

	test('an empty repo list is valid', () => {
		expect(problems(config([]))).toEqual([]);
	});

	const current = (c: Config): SettingsResponse => ({ ...settingsFromConfig(c), version: 'v1', mode: 'personal', fields: { '/personal': { editable: true } } });
	const put = (now: SettingsResponse, personal: Partial<PersonalSettings>) => checkSettingsPut({ version: 'v1', personal }, { current: now });

	test('a PUT without anyRepo keeps the current value; with it, it changes', () => {
		const now = current(config([app], { orgs: ['example-org'] }));
		const { anyRepo: _drop, ...older } = structuredClone(now.personal);
		const kept = put(now, older);
		expect(kept.ok && kept.personal.anyRepo).toEqual({ github: { orgs: ['example-org'] } });
		const off = put(now, { ...structuredClone(now.personal), anyRepo: {} });
		expect(off.ok && off.personal.anyRepo).toEqual({});
		expect(put(now, { ...structuredClone(now.personal), anyRepo: { nowhere: { orgs: ['example-org'] } } }).ok).toBe(false);
		expect(put(now, { ...structuredClone(now.personal), anyRepo: { github: { orgs: [] } } }).ok).toBe(false);
	});

	test('mergePersonal writes anyRepo under each host, and keeps the disk value when the settings lack it', () => {
		const onDisk = config([app], { orgs: ['example-org'] }) as unknown as Record<string, unknown>;
		const personal = settingsFromConfig(onDisk as unknown as Config).personal;
		const on = mergePersonal(onDisk, { ...personal, anyRepo: { github: { orgs: ['other-org'] } } }) as unknown as Config;
		expect(on.hosts.github!.anyRepo).toEqual({ orgs: ['other-org'] });
		const off = mergePersonal(onDisk, { ...personal, anyRepo: {} }) as unknown as Config;
		expect('anyRepo' in off.hosts.github!).toBe(false);
		const { anyRepo: _drop, ...older } = personal;
		const kept = mergePersonal(onDisk, older as PersonalSettings) as unknown as Config;
		expect(kept.hosts.github!.anyRepo).toEqual({ orgs: ['example-org'] });
	});

	test('an import moves anyRepo to the host with the same host name', () => {
		const from = current(config([app], { orgs: ['example-org'] }));
		const target = current(config([app]));
		target.deployment.hosts = { dotcom: target.deployment.hosts.github! };
		target.personal.repos = [{ ...app, host: 'dotcom' }];
		target.personal.team[0]!.logins = { dotcom: 'alice' };
		target.personal.reviewTeams = {};
		const file = JSON.parse(JSON.stringify(exportSettings(from))) as unknown;
		expect(importSettings(file, target).personal.anyRepo).toEqual({ dotcom: { orgs: ['example-org'] } });
	});
});

describe('Add more repos', () => {
	const listed = [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }];

	test('adding the first repo on a host that searches its defaultOrgs keeps it in any-repo mode', () => {
		const c = config([], undefined, {}, { defaultOrgs: ['example-org'] });
		// github has no repos, so it searches its defaults; adding a repo makes them an explicit setting.
		expect(anyRepoAfterAdding(c, 'github')).toEqual({ github: { orgs: ['example-org'] } });
		// The person's own setting stays as it is.
		expect(anyRepoAfterAdding({ ...c, anyRepo: { github: { orgs: ['other-org'] } } }, 'github')).toEqual({ github: { orgs: ['other-org'] } });
		// A host with listed repos is in listed mode on purpose; nothing changes.
		expect(anyRepoAfterAdding(config([app], undefined, {}, { defaultOrgs: ['example-org'] }), 'github')).toEqual({});
		// So is a host with no defaults.
		expect(anyRepoAfterAdding(config([]), 'github')).toEqual({});
	});

	test('unlistedRepos lists each repo that the config lacks, once, matched without case', () => {
		const ids = [
			{ host: 'github', owner: 'Example-Org', name: 'App' },
			{ host: 'github', owner: 'partner-org', name: 'lib' },
			{ host: 'github', owner: 'partner-org', name: 'lib' },
			{ host: 'ghe', owner: 'example-org', name: 'app' },
		];
		expect(unlistedRepos(ids, listed)).toEqual([
			{ host: 'ghe', owner: 'example-org', name: 'app' },
			{ host: 'github', owner: 'partner-org', name: 'lib' },
		]);
		expect(findListed(listed, { host: 'github', owner: 'EXAMPLE-ORG', name: 'app' })?.short).toBe('app');
	});

	test('newRepoEntry uses the repo name as the short name, or owner/name when it is taken', () => {
		expect(newRepoEntry({ host: 'github', owner: 'partner-org', name: 'lib' }, listed)).toEqual({ host: 'github', owner: 'partner-org', name: 'lib', short: 'lib' });
		expect(newRepoEntry({ host: 'ghe', owner: 'example-org', name: 'app' }, listed).short).toBe('example-org/app');
		expect(newRepoEntry({ host: 'ghe', owner: 'example-org', name: 'app' }, [...listed, { short: 'example-org/app' }]).short).toBe('example-org/app (2)');
	});
});
