import { describe, expect, test } from 'bun:test';
import { apiVersionProblem } from './api-version.ts';
import { publicConfig } from './config.ts';
import { API_VERSION, type Config } from './types.ts';

describe('apiVersionProblem', () => {
	test('accepts the version that the client was built with', () => {
		expect(apiVersionProblem({ apiVersion: API_VERSION })).toBe('');
	});

	test('rejects a body with no apiVersion', () => {
		expect(apiVersionProblem({ me: 'alice' })).toContain('sent no API version');
		expect(apiVersionProblem(null)).toContain('sent no API version');
	});

	test('rejects every version other than API_VERSION', () => {
		const msg = apiVersionProblem({ apiVersion: API_VERSION + 1 });
		expect(msg).toContain(`API version ${API_VERSION + 1}`);
		expect(msg).toContain(`supports API version ${API_VERSION}`);
		expect(apiVersionProblem({ apiVersion: API_VERSION - 1 })).toContain(`API version ${API_VERSION - 1}`);
	});

	test('rejects a version that is not a whole number', () => {
		expect(apiVersionProblem({ apiVersion: '1' })).toContain('not a whole number');
		expect(apiVersionProblem({ apiVersion: 1.5 })).toContain('not a whole number');
		expect(apiVersionProblem({ apiVersion: null })).toContain('not a whole number');
	});
});

test('publicConfig sends the API version that the client supports', () => {
	const config = { me: 'alice', team: [], repos: [], hosts: {} } as unknown as Config;
	expect(apiVersionProblem(publicConfig(config))).toBe('');
	expect(publicConfig(config).apiVersion).toBe(API_VERSION);
});
