// The API version check, shared by the browser client and the tests.

import { API_VERSION } from './types.ts';

/** The `apiVersion` values that this client can read. Today, only the version it was built with. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [API_VERSION];

/**
 * Why the client cannot use the `/api/config` body `body`, or '' when its `apiVersion` is supported.
 * A body with no `apiVersion` comes from a server older than the version field, so it is an error too.
 */
export function apiVersionProblem(body: unknown): string {
	const version = typeof body === 'object' && body !== null ? (body as { apiVersion?: unknown }).apiVersion : undefined;
	const supported = SUPPORTED_API_VERSIONS.join(', ');
	if (version === undefined) {
		return `The server sent no API version. This client supports API version ${supported}. Build the client and the server from the same Shepherd commit.`;
	}
	if (typeof version !== 'number' || !Number.isInteger(version)) {
		return `The server sent an API version that is not a whole number (${String(JSON.stringify(version)).slice(0, 40)}). This client supports API version ${supported}.`;
	}
	if (!SUPPORTED_API_VERSIONS.includes(version)) {
		return `The server uses API version ${version}. This client supports API version ${supported}. Build the client and the server from the same Shepherd commit.`;
	}
	return '';
}
