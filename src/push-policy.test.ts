// Push policies: how an author wants to receive changes. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import { problems } from './config.ts';
import { PUSH_POLICY_INSTRUCTIONS, resolvePushPolicy } from './push-policy.ts';
import type { Config, PushPolicy, RepoConfig, TeamMember } from './types.ts';

const member = (id: string, pushPolicy?: PushPolicy): TeamMember => ({
	id,
	name: id,
	short: id,
	logins: { github: `${id}-gh`, work: `${id}-work` },
	...(pushPolicy ? { pushPolicy } : {}),
});
const repo = (name: string, extra: Partial<RepoConfig> = {}): RepoConfig => ({ host: 'github', owner: 'example-org', name, short: name, ...extra });
const pr = (name: string, author: string, host = 'github') => ({ host, owner: 'example-org', repo: name, author });

describe('resolvePushPolicy', () => {
	test('nothing set: no policy, and the instruction says to ask first', () => {
		const r = resolvePushPolicy({ team: [member('alice')], repos: [repo('app')] }, pr('app', 'alice-gh'));
		expect(r).toEqual({ policy: null, source: null, instruction: PUSH_POLICY_INSTRUCTIONS.unset });
	});

	test("the author's policy applies in every repo, on every host they have a login on", () => {
		const config = { team: [member('alice', 'stacked-pr')], repos: [repo('app'), repo('lib', { host: 'work' })] };
		expect(resolvePushPolicy(config, pr('app', 'alice-gh'))).toMatchObject({ policy: 'stacked-pr', source: 'author' });
		expect(resolvePushPolicy(config, pr('lib', 'ALICE-WORK', 'work'))).toMatchObject({ policy: 'stacked-pr', source: 'author' });
	});

	test("the repo's policy covers authors without one, including people outside the team", () => {
		const config = { team: [member('alice')], repos: [repo('app', { pushPolicy: 'push' })] };
		expect(resolvePushPolicy(config, pr('app', 'alice-gh'))).toMatchObject({ policy: 'push', source: 'repo' });
		expect(resolvePushPolicy(config, pr('app', 'outsider'))).toMatchObject({ policy: 'push', source: 'repo' });
	});

	test('author and repo both set: the stricter one wins, either way round', () => {
		const team = [member('alice', 'push'), member('bob', 'review-only')];
		const repos = [repo('app', { pushPolicy: 'stacked-pr' })];
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alice-gh'))).toMatchObject({ policy: 'stacked-pr', source: 'author-and-repo' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'bob-gh'))).toMatchObject({ policy: 'review-only', source: 'author-and-repo' });
	});

	test('a per-author entry in the repo wins, keyed by team id or by login', () => {
		const team = [member('alice', 'review-only')];
		const repos = [repo('app', { pushPolicy: 'review-only', pushPolicyByAuthor: { alice: 'push', 'Outsider': 'stacked-pr' } })];
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alice-gh'))).toMatchObject({ policy: 'push', source: 'repo-author' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'outsider'))).toMatchObject({ policy: 'stacked-pr', source: 'repo-author' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'someone-else'))).toMatchObject({ policy: 'review-only', source: 'repo' });
	});

	test('a repo that is not tracked only uses the author policy', () => {
		const config = { team: [member('alice', 'push')], repos: [repo('app', { pushPolicy: 'review-only' })] };
		expect(resolvePushPolicy(config, pr('other', 'alice-gh'))).toMatchObject({ policy: 'push', source: 'author' });
	});
});

describe('config checks', () => {
	const base = (): Partial<Config> => ({
		me: 'alice',
		team: [member('alice')],
		hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null }, work: { hostname: 'ghe.example.com', label: 'Work', bot: null } },
		repos: [repo('app')],
	});

	test('valid policies pass', () => {
		const c = base();
		c.team = [member('alice', 'review-only')];
		c.repos = [repo('app', { pushPolicy: 'push', pushPolicyByAuthor: { alice: 'stacked-pr' } })];
		expect(problems(c)).toEqual([]);
	});

	test('unknown values are reported', () => {
		const c = base();
		c.team = [{ ...member('alice'), pushPolicy: 'force-push' as PushPolicy }];
		c.repos = [repo('app', { pushPolicy: 'yes' as PushPolicy, pushPolicyByAuthor: { alice: 'nope' as PushPolicy } })];
		const out = problems(c);
		expect(out).toHaveLength(3);
		expect(out[0]).toContain('team[0] (alice) needs "pushPolicy"');
		expect(out[1]).toContain('repos[0] (example-org/app) needs "pushPolicy"');
		expect(out[2]).toContain('pushPolicyByAuthor."alice"');
	});

	test('pushPolicyByAuthor must be an object', () => {
		const c = base();
		c.repos = [repo('app', { pushPolicyByAuthor: ['alice'] as unknown as Record<string, PushPolicy> })];
		expect(problems(c)[0]).toContain('needs "pushPolicyByAuthor" to be an object');
	});
});
