// Which repos a host finds PRs in: the listed repos, or any repo of a list of orgs (never any repo in any org).
// A host with no listed repos searches its `defaultOrgs`, when someone on the team has a login there.
// Shared by the list and merged searches, the follow-ups guard, the MCP tools and /api/config. See docs/configuration.md.

import type { AnyRepoScope, Config, RepoConfig } from './types.ts';

type ScopeConfig = Pick<Config, 'hosts' | 'repos' | 'team'>;

const lower = (s: string): string => s.toLowerCase();

/** The host keys to search: the hosts of the listed repos, plus the hosts in any-repo mode. */
export function searchHostKeys(config: ScopeConfig): string[] {
	const keys = new Set(config.repos.map((r) => r.host));
	for (const key of Object.keys(config.hosts)) if (anyRepoOrgs(config, key) !== null) keys.add(key);
	return [...keys];
}

const orgList = (orgs: string[] | undefined): string[] => (orgs ?? []).filter(Boolean);

/**
 * The orgs of a host in any-repo mode (never empty), or null when it searches only its listed repos. A host is in any-repo
 * mode when it sets `anyRepo` with orgs, or when it has no listed repos, someone on the team has a login there, and it sets
 * `defaultOrgs`.
 */
export function anyRepoOrgs(config: ScopeConfig, hostKey: string): string[] | null {
	if (!Object.hasOwn(config.hosts, hostKey)) return null;
	const orgs = orgList(config.hosts[hostKey]!.anyRepo?.orgs);
	return orgs.length ? orgs : defaultScope(config, hostKey);
}

/**
 * The orgs that a host with no `anyRepo` setting searches by default: its `defaultOrgs`, when it has no listed repos and
 * someone on the team has a login there. Otherwise null.
 */
export function defaultScope(config: ScopeConfig, hostKey: string): string[] | null {
	const orgs = Object.hasOwn(config.hosts, hostKey) ? orgList(config.hosts[hostKey]!.defaultOrgs) : [];
	const used = !config.repos.some((r) => r.host === hostKey) && config.team.some((m) => Object.hasOwn(m.logins, hostKey) && Boolean(m.logins[hostKey]));
	return used && orgs.length ? orgs : null;
}

/**
 * The `anyRepo` settings after "Add more repos" adds a repo on `hostKey`. A host that is in any-repo mode only by default
 * (no listed repos) would switch to its listed repos when it gets its first one, so it gets its default orgs as an explicit
 * setting, to stay in any-repo mode.
 */
export function anyRepoAfterAdding(config: ScopeConfig & { anyRepo?: Record<string, AnyRepoScope> }, hostKey: string): Record<string, AnyRepoScope> {
	const scopes = { ...(config.anyRepo ?? {}) };
	const orgs = Object.hasOwn(scopes, hostKey) ? null : defaultScope(config, hostKey);
	if (orgs) scopes[hostKey] = { orgs: [...orgs] };
	return scopes;
}

/** The listed repo for a PR's repo, matched without case, or undefined. */
export function listedRepo(config: Pick<Config, 'repos'>, host: string, owner: string, name: string): RepoConfig | undefined {
	return config.repos.find((r) => r.host === host && lower(r.owner) === lower(owner) && lower(r.name) === lower(name));
}

/** True when the host finds PRs in this repo: a listed repo, or any repo in its any-repo scope. */
export function inScope(config: ScopeConfig, host: string, owner: string, name: string): boolean {
	if (listedRepo(config, host, owner, name)) return true;
	return (anyRepoOrgs(config, host) ?? []).some((o) => lower(o) === lower(owner));
}

/**
 * The search qualifiers that limit a search on one host to its scope. GitHub ORs `repo:` and `org:` qualifiers, so
 * `org:a repo:b/c` finds PRs in the org and in the repo. Null means nothing to search (a host in listed mode with no repos
 * that `repos` picks). `repos` picks the listed repos to name (all of them by default); in any-repo mode every listed repo
 * outside the orgs is named, since the search covers them anyway.
 * In any-repo mode the search leaves out archived repos (`archived:false`).
 */
export function scopeQualifiers(config: ScopeConfig, hostKey: string, repos: (r: RepoConfig) => boolean = () => true): string | null {
	const orgs = anyRepoOrgs(config, hostKey);
	const listed = config.repos.filter((r) => r.host === hostKey && (orgs !== null || repos(r)));
	// Listed repos inside an allowed org are already covered by its `org:`.
	const extra = orgs ? listed.filter((r) => !orgs.some((o) => lower(o) === lower(r.owner))) : listed;
	const parts = [...(orgs ?? []).map((o) => `org:${o}`), ...extra.map((r) => `repo:${r.owner}/${r.name}`), ...(orgs ? ['archived:false'] : [])];
	return parts.length ? parts.join(' ') : null;
}

/** Search terms joined by spaces, without the empty ones. */
export const searchTerms = (...parts: (string | null | undefined)[]): string => parts.filter(Boolean).join(' ');
