// Which login is the AI-review bot of a repo. Shared by the server (detail shaping, participants, follow-ups, MCP)
// and the browser client (the AI-review column), so both give the same answer.

import type { RepoConfig } from './types.ts';

interface BotConfig {
	hosts: Record<string, { bot?: string | null }>;
	repos: Pick<RepoConfig, 'host' | 'owner' | 'name' | 'bot'>[];
}

/**
 * The AI-review bot of `owner/name` on `host`: the repo's `bot` when the repo sets one (a login, or null for none),
 * else the host's `bot`. Null when there is none. Repos match case-insensitively, as GitHub names do.
 */
export function reviewBot(config: BotConfig, host: string, owner: string, name: string): string | null {
	const o = owner.toLowerCase();
	const n = name.toLowerCase();
	const repo = config.repos.find((r) => r.host === host && r.owner.toLowerCase() === o && r.name.toLowerCase() === n);
	if (repo && repo.bot !== undefined) return repo.bot || null;
	return config.hosts[host]?.bot || null;
}

/** Every AI-review bot login of the config, lowercased: the hosts' and the repos'. */
export function allReviewBots(config: BotConfig): string[] {
	const logins = [...Object.values(config.hosts).map((h) => h.bot), ...config.repos.map((r) => r.bot)];
	return [...new Set(logins.filter((l): l is string => Boolean(l)).map((l) => l.toLowerCase()))];
}
