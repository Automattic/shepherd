import { describe, expect, test } from 'bun:test';
import { problems, publicConfig } from './config.ts';
import { resolveFeatures } from './features.ts';
import type { Config } from './types.ts';

describe('resolveFeatures', () => {
	test('a missing object turns every feature on', () => {
		expect(resolveFeatures(undefined)).toEqual({ shipped: true, followups: true, herdr: true, settings: false });
		expect(resolveFeatures(null)).toEqual({ shipped: true, followups: true, herdr: true, settings: false });
	});

	test('a missing key turns that feature on', () => {
		expect(resolveFeatures({ herdr: false, settings: false })).toEqual({ shipped: true, followups: true, herdr: false, settings: false });
		expect(resolveFeatures({ followups: false })).toEqual({ shipped: true, followups: false, herdr: true, settings: false });
	});

	test('only false turns a feature off', () => {
		expect(resolveFeatures({ shipped: 0, followups: 'no', herdr: null })).toEqual({ shipped: true, followups: true, herdr: true, settings: false });
	});

	test('settings is on only when the server sends true', () => {
		expect(resolveFeatures({ settings: true }).settings).toBe(true);
		for (const v of [undefined, false, 1, 'yes']) expect(resolveFeatures({ settings: v }).settings).toBe(false);
	});

	test('follow-ups are off when Shipped is off', () => {
		expect(resolveFeatures({ shipped: false, followups: true })).toEqual({ shipped: false, followups: false, herdr: true, settings: false });
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
		expect(problems(base)).toEqual([]);
	});

	test('accepts true and false for known keys', () => {
		expect(problems({ ...base, features: { shipped: false, followups: true, herdr: false } })).toEqual([]);
	});

	test('rejects a value that is not an object', () => {
		expect(problems({ ...base, features: [] as never })).toEqual(['`features` must be an object (or remove it)']);
		expect(problems({ ...base, features: 'off' as never })).toEqual(['`features` must be an object (or remove it)']);
	});

	test('rejects unknown keys and values that are not true or false', () => {
		expect(problems({ ...base, features: { shiped: false, herdr: 'no' } as never })).toEqual([
			'`features.shiped` is not a feature (use shipped, followups or herdr)',
			'`features.herdr` must be true or false',
		]);
	});

	test('the public config sends every feature, on by default', () => {
		expect(publicConfig(base).features).toEqual({ shipped: true, followups: true, herdr: true, settings: true });
	});

	test('the public config sends the features that config.json turns off', () => {
		expect(publicConfig({ ...base, features: { shipped: false } }).features).toEqual({ shipped: false, followups: false, herdr: true, settings: true });
	});

	test('herdr is off when herdr.enabled is false', () => {
		expect(publicConfig({ ...base, herdr: { enabled: false } }).features?.herdr).toBe(false);
		expect(publicConfig({ ...base, herdr: { enabled: false }, features: { herdr: true } }).features?.herdr).toBe(false);
		expect(publicConfig({ ...base, herdr: { enabled: true } }).features?.herdr).toBe(true);
	});
});
