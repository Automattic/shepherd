import { describe, expect, test } from 'bun:test';
import { configProblems, publicConfig } from './config.ts';
import { resolveFeatures } from './features.ts';
import type { Config } from './types.ts';

describe('resolveFeatures', () => {
	test('a missing object turns every feature on', () => {
		expect(resolveFeatures(undefined)).toEqual({ shipped: true, followups: true, herdr: true });
		expect(resolveFeatures(null)).toEqual({ shipped: true, followups: true, herdr: true });
	});

	test('a missing key turns that feature on', () => {
		expect(resolveFeatures({ herdr: false })).toEqual({ shipped: true, followups: true, herdr: false });
		expect(resolveFeatures({ followups: false })).toEqual({ shipped: true, followups: false, herdr: true });
	});

	test('only false turns a feature off', () => {
		expect(resolveFeatures({ shipped: 0, followups: 'no', herdr: null })).toEqual({ shipped: true, followups: true, herdr: true });
	});

	test('follow-ups are off when Shipped is off', () => {
		expect(resolveFeatures({ shipped: false, followups: true })).toEqual({ shipped: false, followups: false, herdr: true });
	});
});

const base: Config = {
	me: 'alice',
	team: [{ id: 'alice', name: 'Alice', short: 'Alice', logins: { github: 'alice' } }],
	hosts: { github: { hostname: 'github.com', label: 'GitHub', bot: null } },
	repos: [{ host: 'github', owner: 'example-org', name: 'app', short: 'app' }],
	linear: null,
} as unknown as Config;

describe('features in config.json', () => {
	test('a config with no features block is valid', () => {
		expect(configProblems(base)).toEqual([]);
	});

	test('accepts true and false for known keys', () => {
		expect(configProblems({ ...base, features: { shipped: false, followups: true, herdr: false } })).toEqual([]);
	});

	test('rejects a value that is not an object', () => {
		expect(configProblems({ ...base, features: [] as never })).toEqual(['`features` must be an object, or no such field']);
		expect(configProblems({ ...base, features: 'off' as never })).toEqual(['`features` must be an object, or no such field']);
	});

	test('rejects unknown keys and values that are not true or false', () => {
		expect(configProblems({ ...base, features: { shiped: false, herdr: 'no' } as never })).toEqual([
			'`features.shiped` is not a feature (use shipped, followups or herdr)',
			'`features.herdr` must be true or false',
		]);
	});

	test('the public config sends every feature, on by default', () => {
		expect(publicConfig(base).features).toEqual({ shipped: true, followups: true, herdr: true });
	});

	test('the public config sends the features that config.json turns off', () => {
		expect(publicConfig({ ...base, features: { shipped: false } }).features).toEqual({ shipped: false, followups: false, herdr: true });
	});

	test('herdr is off when herdr.enabled is false', () => {
		expect(publicConfig({ ...base, herdr: { enabled: false } }).features?.herdr).toBe(false);
		expect(publicConfig({ ...base, herdr: { enabled: false }, features: { herdr: true } }).features?.herdr).toBe(false);
		expect(publicConfig({ ...base, herdr: { enabled: true } }).features?.herdr).toBe(true);
	});
});
