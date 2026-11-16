// The API version check, shared by the browser client and the tests.

import { API_VERSION } from './types.ts';

/**
 * Why the client cannot use the `/api/config` body `body`, or '' when its `apiVersion` is the client's `API_VERSION`.
 * The client accepts only that one version. A body with no `apiVersion` comes from a server older than the version field, so it is an error too.
 */
export function apiVersionProblem(body: unknown): string {
	const version = typeof body === 'object' && body !== null ? (body as { apiVersion?: unknown }).apiVersion : undefined;
	if (version === undefined) {
		return `The server sent no API version. This client supports API version ${API_VERSION}. Build the client and the server from the same Shepherd commit.`;
	}
	if (typeof version !== 'number' || !Number.isInteger(version)) {
		return `The server sent an API version that is not a whole number (${String(JSON.stringify(version)).slice(0, 40)}). This client supports API version ${API_VERSION}.`;
	}
	if (version !== API_VERSION) {
		return `The server uses API version ${version}. This client supports API version ${API_VERSION}. Build the client and the server from the same Shepherd commit.`;
	}
	return '';
}
