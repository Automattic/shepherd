// Exporting personal settings from one server and importing them into another. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import { checkSettingsPut, settingsFromConfig } from './settings.ts';
import { exportSettings, importSettings } from './settings-transfer.ts';
import type { Config, SettingsResponse } from './types.ts';

/** A local server: hosts `ghe` and `github`, a third host `extra`, and the viewer `alice`. */
const local = (): SettingsResponse => {
	const c: Config = {
		me: 'alice',
		team: [
			{ id: 'alice', name: 'Alice', short: 'Alice', logins: { ghe: 'alice-ent', github: 'alice-gh' }, pushPolicy: 'push' },
			{ id: 'bob', name: 'Bob', short: 'Bob', logins: { github: 'bob-gh', extra: 'bob-x' } },
		],
		hosts: {
			ghe: { hostname: 'github.example.com', label: 'GHE', bot: 'review-bot', reviewTeams: ['example-org/reviewers'] },
			github: { hostname: 'github.com', label: 'GitHub', bot: null, botsByOwner: { 'other-org': 'other-bot' } },
			extra: { hostname: 'git.example.org', label: 'Extra', bot: null },
		},
		repos: [
			{ host: 'ghe', owner: 'example-org', name: 'app', short: 'app', pushPolicyByAuthor: { alice: 'stacked-pr', bob: 'review-only' } },
			{ host: 'extra', owner: 'example-org', name: 'tool', short: 'tool' },
		],
		linear: { workspace: 'example', keys: ['ENG'] },
		features: { herdr: false },
	};
	return {
		...settingsFromConfig(c),
		version: 'local-v1',
		mode: 'personal',
		fields: {
			'/personal': { editable: true },
			'/personal/me': { editable: false },
			'/deployment/hosts': { editable: true },
		},
	};
};

/** A host that embeds the client: other host keys, no third host, hosts locked, `me` fixed and herdr not available. */
const embedded = (): SettingsResponse => ({
	personal: {
		me: 'alice.smith',
		team: [{ id: 'alice.smith', name: 'Alice Smith', short: 'Alice', logins: { enterprise: 'alice-ent', dotcom: 'alice-gh' } }],
		repos: [],
		reviewTeams: {},
		linear: null,
		features: { herdr: false },
	},
	deployment: {
		hosts: {
			enterprise: { hostname: 'GitHub.Example.com', label: 'Enterprise', bot: 'review-bot' },
			dotcom: { hostname: 'github.com', label: 'GitHub', bot: null },
		},
		refresh: 'list',
		aiReviewLabel: 'AI review',
		ignoreParticipants: [],
		limits: {},
	},
	version: 'mc-v1',
	mode: 'personal',
	fields: {
		'/personal': { editable: true },
		'/personal/me': { editable: false, reason: 'From your profile.' },
		'/personal/features/herdr': { editable: false, reason: 'No herdr here.' },
		'/deployment': { editable: false },
	},
});

const fileOf = (s: SettingsResponse) => JSON.parse(JSON.stringify(exportSettings(s, new Date('2026-01-01T00:00:00Z')))) as unknown;

describe('settings export and import', () => {
	test('the file names its format, version and each host by host name', () => {
		const file = exportSettings(local(), new Date('2026-01-01T00:00:00Z'));
		expect([file.format, file.version, file.exportedAt]).toEqual(['shepherd-settings', 1, '2026-01-01T00:00:00.000Z']);
		expect(file.hosts.github).toEqual({ hostname: 'github.com', label: 'GitHub', bot: null, botsByOwner: { 'other-org': 'other-bot' } });
		expect(file.personal).toEqual(local().personal);
	});

	test('an import into the same server gives the same settings, with nothing to say', () => {
		const r = importSettings(fileOf(local()), local());
		expect(r.personal).toEqual(local().personal);
		expect(r.hosts).toBeUndefined();
		expect(r.notes).toEqual([]);
	});

	test('an import into another server follows host names, keeps who the viewer is there, and passes its checks', () => {
		const target = embedded();
		const r = importSettings(fileOf(local()), target);
		const p = r.personal;
		expect(p.me).toBe('alice.smith');
		expect(p.team.map((m) => [m.id, m.logins])).toEqual([
			['alice.smith', { enterprise: 'alice-ent', dotcom: 'alice-gh' }],
			['bob', { dotcom: 'bob-gh' }],
		]);
		// The repo on the host that this server lacks is left out; the other moves to this server's key.
		expect(p.repos.map((x) => [x.host, x.name])).toEqual([['enterprise', 'app']]);
		// A per-author policy follows the viewer to their id here.
		expect(p.repos[0]!.pushPolicyByAuthor).toEqual({ 'alice.smith': 'stacked-pr', bob: 'review-only' });
		expect(p.reviewTeams).toEqual({ enterprise: ['example-org/reviewers'] });
		expect(p.features).toEqual({ herdr: false });
		expect(r.hosts).toBeUndefined();
		expect(r.notes).toEqual([
			'This server has no host git.example.org, so the logins, repos and review teams there were left out.',
			'You are "alice.smith" on this server, so the file\'s "alice" became "alice.smith".',
		]);
		expect(checkSettingsPut({ version: target.version, personal: p }, { current: target }).ok).toBe(true);
	});

	test('an import back into the local server adds the hosts it lacks and keeps the local viewer', () => {
		const target = local();
		const fromEmbedded = embedded();
		fromEmbedded.personal.repos = [{ host: 'enterprise', owner: 'example-org', name: 'app', short: 'app' }];
		fromEmbedded.deployment.hosts.more = { hostname: 'more.example.com', label: 'More', bot: 'more-bot' };
		fromEmbedded.personal.team[0]!.logins.more = 'alice-more';
		const r = importSettings(fileOf(fromEmbedded), target);
		expect(r.personal.me).toBe('alice');
		expect(r.personal.team[0]).toEqual({ id: 'alice', name: 'Alice Smith', short: 'Alice', logins: { ghe: 'alice-ent', github: 'alice-gh', more: 'alice-more' } });
		expect(r.personal.repos).toEqual([{ host: 'ghe', owner: 'example-org', name: 'app', short: 'app' }]);
		expect(r.hosts?.more).toEqual({ hostname: 'more.example.com', label: 'More', bot: 'more-bot' });
		expect(r.notes).toContain('Added the host more.example.com (as "more"), with the AI-review bot more-bot.');
	});

	test('a field that the target does not let the viewer change keeps its value there', () => {
		const target = embedded();
		target.fields['/personal/linear'] = { editable: false };
		const r = importSettings(fileOf(local()), target);
		expect(r.personal.linear).toBeNull();
		expect(r.notes).toContain("This server sets linear itself, so the file's linear was not used.");
	});

	test('a file that is not a settings file says so', () => {
		expect(() => importSettings({ hello: 1 }, local())).toThrow('This is not a Shepherd settings file.');
		expect(() => importSettings({ ...(fileOf(local()) as object), version: 9 }, local())).toThrow('version 9');
		expect(() => importSettings({ format: 'shepherd-settings', version: 1, hosts: {}, personal: {} }, local())).toThrow('no team or no repos');
	});
});
