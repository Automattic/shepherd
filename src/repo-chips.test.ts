import { describe, expect, test } from 'bun:test';
import { parseRepoKey, repoChipLabels, repoKey, type RepoId } from './repo-chips.ts';

const id = (host: string, owner: string, name: string): RepoId => ({ host, owner, name });
const hostLabel = (host: string): string => (host === 'github' ? 'GitHub' : 'GHE');

describe('repoKey and parseRepoKey', () => {
	test('a key holds the host, the owner and the name', () => {
		const r = id('github', 'Automattic', 'wp-calypso');
		expect(repoKey(r)).toBe('github:Automattic/wp-calypso');
		expect(parseRepoKey(repoKey(r))).toEqual(r);
	});

	test('a name can hold a dot', () => {
		expect(parseRepoKey('ghe:org/a.b')).toEqual(id('ghe', 'org', 'a.b'));
	});

	test('a key from an older version (only a name) gives an empty host and owner', () => {
		expect(parseRepoKey('jetpack')).toEqual(id('', '', 'jetpack'));
	});
});

describe('repoChipLabels', () => {
	test('a name that only one repo has is the label', () => {
		expect(repoChipLabels([id('github', 'Automattic', 'jetpack'), id('github', 'Automattic', 'wp-calypso')], hostLabel)).toEqual([
			'jetpack',
			'wp-calypso',
		]);
	});

	test('two owners with the same repo name get owner/name', () => {
		expect(
			repoChipLabels(
				[id('github', 'Automattic', 'wp-calypso'), id('github', 'fork-owner', 'wp-calypso'), id('github', 'Automattic', 'jetpack')],
				hostLabel,
			),
		).toEqual(['Automattic/wp-calypso', 'fork-owner/wp-calypso', 'jetpack']);
	});

	test('the same owner/name on two hosts adds the host label', () => {
		expect(repoChipLabels([id('github', 'Automattic', 'jetpack'), id('ghe', 'Automattic', 'jetpack')], hostLabel)).toEqual([
			'Automattic/jetpack (GitHub)',
			'Automattic/jetpack (GHE)',
		]);
	});

	test('an old saved key (only a name) keeps the name, and a repo with the same name gets owner/name', () => {
		expect(repoChipLabels([id('github', 'Automattic', 'jetpack'), parseRepoKey('jetpack')], hostLabel)).toEqual([
			'Automattic/jetpack',
			'jetpack',
		]);
	});
});
