// Push policies: how an author wants to receive changes. Run with `bun test`.

import { describe, expect, test } from 'bun:test';
import { problems, warnings } from './config.ts';
import { OWN_PR_INSTRUCTION, PUSH_POLICY_INSTRUCTIONS, resolvePushPolicy } from './push-policy.ts';
import type { Config, PushPolicy, RepoConfig, TeamMember } from './types.ts';

const member = (id: string, pushPolicy?: PushPolicy, logins?: Record<string, string>): TeamMember => ({
	id,
	name: id,
	short: id,
	logins: logins ?? { github: `${id}-gh`, work: `${id}-work` },
	...(pushPolicy ? { pushPolicy } : {}),
});
const repo = (name: string, extra: Partial<RepoConfig> = {}): RepoConfig => ({ host: 'github', owner: 'example-org', name, short: name, ...extra });
const pr = (name: string, author: string, host = 'github', fork: string | null = null) => ({ host, owner: 'example-org', repo: name, author, fork });

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

	test("the repo's policy covers team members without one, and outsiders unless it is push", () => {
		const team = [member('alice')];
		const push = { team, repos: [repo('app', { pushPolicy: 'push' })] };
		expect(resolvePushPolicy(push, pr('app', 'alice-gh'))).toMatchObject({ policy: 'push', source: 'repo' });
		expect(resolvePushPolicy(push, pr('app', 'outsider'))).toMatchObject({ policy: 'stacked-pr', source: 'repo-outside-team' });
		const reviewOnly = { team, repos: [repo('app', { pushPolicy: 'review-only' })] };
		expect(resolvePushPolicy(reviewOnly, pr('app', 'outsider'))).toMatchObject({ policy: 'review-only', source: 'repo' });
	});

	test('author and repo both set: the stricter one wins, either way round', () => {
		const team = [member('alice', 'push'), member('bob', 'review-only')];
		const repos = [repo('app', { pushPolicy: 'stacked-pr' })];
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alice-gh'))).toMatchObject({ policy: 'stacked-pr', source: 'author-and-repo' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'bob-gh'))).toMatchObject({ policy: 'review-only', source: 'author-and-repo' });
	});

	test('a per-author entry in the repo wins, keyed by team id or by login', () => {
		const team = [member('alice', 'review-only'), member('bob')];
		const repos = [repo('app', { pushPolicy: 'review-only', pushPolicyByAuthor: { alice: 'push', 'bob-gh': 'stacked-pr', Outsider: 'push' } })];
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alice-gh'))).toMatchObject({ policy: 'push', source: 'repo-author' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'bob-gh'))).toMatchObject({ policy: 'stacked-pr', source: 'repo-author' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'outsider'))).toMatchObject({ policy: 'push', source: 'repo-author' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'someone-else'))).toMatchObject({ policy: 'review-only', source: 'repo' });
	});

	test("a key that is a team id never matches an outsider whose login is the same", () => {
		const team = [member('alex', undefined, { github: 'alex-gh' })];
		const repos = [repo('app', { pushPolicy: 'review-only', pushPolicyByAuthor: { alex: 'push' } })];
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alex'))).toMatchObject({ policy: 'review-only', source: 'repo' });
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alex-gh'))).toMatchObject({ policy: 'push', source: 'repo-author' });
	});

	test("a member's id key wins over their login key, in either order", () => {
		const team = [member('alex', undefined, { github: 'alex-gh' })];
		const a = [repo('app', { pushPolicyByAuthor: { 'alex-gh': 'review-only', alex: 'push' } })];
		const b = [repo('app', { pushPolicyByAuthor: { alex: 'push', 'alex-gh': 'review-only' } })];
		expect(resolvePushPolicy({ team, repos: a }, pr('app', 'alex-gh'))).toMatchObject({ policy: 'push' });
		expect(resolvePushPolicy({ team, repos: b }, pr('app', 'alex-gh'))).toMatchObject({ policy: 'push' });
	});

	test('a repo that is not tracked only uses the author policy', () => {
		const config = { team: [member('alice', 'push')], repos: [repo('app', { pushPolicy: 'review-only' })] };
		expect(resolvePushPolicy(config, pr('other', 'alice-gh'))).toMatchObject({ policy: 'push', source: 'author' });
	});

	test('your own PRs always allow pushes, whatever the config says', () => {
		const team = [member('me', 'review-only')];
		const repos = [repo('app', { pushPolicy: 'review-only', pushPolicyByAuthor: { me: 'review-only' } })];
		expect(resolvePushPolicy({ me: 'me', team, repos }, pr('app', 'me-gh'))).toEqual({ policy: 'push', source: 'own', instruction: OWN_PR_INSTRUCTION });
		expect(resolvePushPolicy({ me: 'me', team, repos }, pr('app', 'me-gh', 'github', 'me-gh'))).toMatchObject({ policy: 'push', source: 'own' });
	});

	test('a PR from a fork is review-only, whatever else is set', () => {
		const team = [member('alice', 'push')];
		const repos = [repo('app', { pushPolicy: 'push', pushPolicyByAuthor: { outsider: 'push' } })];
		const fromFork = resolvePushPolicy({ team, repos }, pr('app', 'outsider', 'github', 'outsider'));
		expect(fromFork).toMatchObject({ policy: 'review-only', source: 'fork' });
		expect(fromFork.instruction).toContain("outsider's fork");
		expect(resolvePushPolicy({ team, repos }, pr('app', 'alice-gh', 'github', 'alice-gh'))).toMatchObject({ policy: 'review-only', source: 'fork' });
		expect(resolvePushPolicy({ team: [member('alice')], repos: [repo('app')] }, pr('app', 'x', 'github', 'x'))).toMatchObject({ policy: 'review-only', source: 'fork' });
	});

	test('the instruction says where the policy came from', () => {
		const team = [member('alice', 'push'), member('bob')];
		const repos = [repo('app', { pushPolicy: 'push' })];
		expect(resolvePushPolicy({ team, repos }, pr('app', 'bob-gh')).instruction).toStartWith("This repo's default");
		expect(resolvePushPolicy({ team, repos }, pr('app', 'outsider')).instruction).toStartWith('This repo allows pushes from the team, but the author is outside the team.');
		expect(resolvePushPolicy({ team, repos: [repo('app')] }, pr('app', 'alice-gh')).instruction).toStartWith("The author's preference.");
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
		expect(warnings(c as Config)).toEqual([]);
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

	test('warns about keys that match nobody on the team, name one member twice, or collide', () => {
		const c = base() as Config;
		c.team = [member('alice'), member('alex', undefined, { github: 'alex-gh' }), member('sam', undefined, { github: 'alex' })];
		c.repos = [repo('app', { pushPolicyByAuthor: { alxe: 'push', alice: 'push', 'alice-gh': 'review-only', alex: 'push' } })];
		const out = warnings(c);
		expect(out).toHaveLength(3);
		expect(out[0]).toContain('"alxe" matches no team id or github.com login on the team');
		expect(out[1]).toContain('"alice-gh" and "alice" both name team member alice');
		expect(out[2]).toContain('"alex" is the team id of alex and the github.com login of sam; it applies only to alex');
	});
});
