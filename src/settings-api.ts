// GET and PUT /api/settings on the local server, with config.json as the storage.
// A host that embeds the client gives the same responses from its own storage (see docs/embedding.md).

import { configFeatures } from './config.ts';
import { checkSettingsPut, localRules, settingsFromConfig } from './settings.ts';
import { SettingsConflictError, SettingsWriteError, type ConfigStore } from './settings-store.ts';
import type { ErrorResponse, FieldMeta, SettingsErrorResponse, SettingsResponse } from './types.ts';

const DEPLOYMENT_REASON = 'Set in config.json on the server. Restart the server to apply a change.';
const HOST_FILE_REASON = 'Set in config.json on the server.';
const ENTERPRISE_TOKEN_REASON =
	'The server has GH_ENTERPRISE_TOKEN (or GITHUB_ENTERPRISE_TOKEN) set, and gh sends that token to any GitHub Enterprise host. Add hosts and change host names in config.json.';

/** True when gh would send an environment token to any GitHub Enterprise host, so a host name must not come from the panel. */
export const hasEnterpriseToken = (env: Record<string, string | undefined> = process.env): boolean =>
	Boolean(env.GH_ENTERPRISE_TOKEN?.trim() || env.GITHUB_ENTERPRISE_TOKEN?.trim());

/** What GET /api/settings sends for the store's current config. */
export function localSettings(store: ConfigStore, env: Record<string, string | undefined> = process.env): SettingsResponse {
	const config = store.config;
	const fields: Record<string, FieldMeta> = {
		'/personal': { editable: true },
		'/personal/me': { editable: false, reason: 'Who you are on this server. Set `me` in config.json.' },
		// The hosts are editable here, apart from the fields that start processes or set their limits.
		'/deployment/hosts': { editable: true },
		'/deployment/hosts/*/concurrency': { editable: false, reason: HOST_FILE_REASON },
		'/deployment/hosts/*/rowRefreshFloorMs': { editable: false, reason: HOST_FILE_REASON },
		'/deployment/hosts/*/rowRefreshLowBudgetMs': { editable: false, reason: HOST_FILE_REASON },
		'/deployment/refresh': { editable: false, reason: DEPLOYMENT_REASON },
		'/deployment/aiReviewLabel': { editable: false, reason: DEPLOYMENT_REASON },
		'/deployment/ignoreParticipants': { editable: false, reason: DEPLOYMENT_REASON },
		'/deployment/limits': { editable: false, reason: DEPLOYMENT_REASON },
	};
	if (hasEnterpriseToken(env)) {
		// Only the label and the bot of the existing hosts.
		fields['/deployment/hosts'] = { editable: false, reason: ENTERPRISE_TOKEN_REASON };
		fields['/deployment/hosts/*/label'] = { editable: true };
		fields['/deployment/hosts/*/bot'] = { editable: true };
		fields['/deployment/hosts/*/botsByOwner'] = { editable: true };
	}
	// A feature that the server turns off stays off, so its switch would change nothing.
	if (!configFeatures({ ...config, features: {} }).herdr) {
		fields['/personal/features/herdr'] = { editable: false, reason: 'herdr is turned off in config.json on the server ("herdr": { "enabled": false }).' };
	}
	return {
		...settingsFromConfig(config),
		version: store.version,
		mode: 'personal',
		fields,
		...(store.problems.length ? { problems: store.problems } : {}),
	};
}

const json = <T>(status: number, body: T) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export interface SettingsHandlerOptions {
	/** True when a request that changes state comes from the dashboard. */
	sameOrigin(req: Request): boolean;
}

export function createSettingsHandler(store: ConfigStore, { sameOrigin }: SettingsHandlerOptions) {
	return async function handleSettings(req: Request): Promise<Response> {
		await store.refresh();
		if (req.method === 'GET') return json<SettingsResponse>(200, localSettings(store));
		if (req.method !== 'PUT') return json<ErrorResponse>(405, { error: 'use GET or PUT' });
		if (!sameOrigin(req)) return json<ErrorResponse>(403, { error: 'PUT from the dashboard only' });
		if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) {
			return json<ErrorResponse>(415, { error: 'send the settings as application/json' });
		}
		const body: unknown = await req.json().catch(() => undefined);
		const current = localSettings(store);
		const result = checkSettingsPut(body, { current, refuse: (next) => localRules(next) });
		if (!result.ok) return json<SettingsErrorResponse>(result.status, result.body);
		try {
			await store.save(result.personal, current.version, result.deployment.hosts);
		} catch (e) {
			if (e instanceof SettingsConflictError) {
				const settings = localSettings(store);
				const why = settings.problems?.length ? ` config.json has problems to fix first: ${settings.problems.join('; ')}` : '';
				return json<SettingsErrorResponse>(409, { error: `The settings changed on the server. Load them again and repeat your change.${why}`, errors: [], settings });
			}
			console.error(e);
			// The message names the file, not its folder.
			return json<SettingsErrorResponse>(500, { error: e instanceof SettingsWriteError ? e.message : 'Could not save the settings; the server log has the details.', errors: [] });
		}
		return json<SettingsResponse>(200, localSettings(store));
	};
}
