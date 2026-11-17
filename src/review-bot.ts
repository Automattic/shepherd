// Which login is the AI-review bot of a pull request. Shared by the server (detail shaping, participants, follow-ups, MCP)
// and the browser client (the AI-review column), so both give the same answer. A host that ports the data layer applies
// the same rule (docs/embedding.md).

interface BotHosts {
	hosts: Record<string, { bot?: string | null; botsByOwner?: Record<string, string | null> }>;
}

/**
 * The AI-review bot of a PR in `owner`'s repos on `host`: the host's `botsByOwner` entry for the owner (an org or a user)
 * when it has one (a login, or null for none), else the host's `bot`. Null when there is none. Owners match
 * case-insensitively, as GitHub names do.
 */
export function reviewBot(config: BotHosts, host: string, owner: string): string | null {
	const h = config.hosts[host];
	if (!h) return null;
	const o = owner.toLowerCase();
	const entry = Object.entries(h.botsByOwner ?? {}).find(([k]) => k.toLowerCase() === o);
	if (entry) return entry[1] || null;
	return h.bot || null;
}

/** Every AI-review bot login of the config, lowercased: the hosts' defaults and their per-owner bots. */
export function allReviewBots(config: BotHosts): string[] {
	const logins = Object.values(config.hosts).flatMap((h) => [h.bot, ...Object.values(h.botsByOwner ?? {})]);
	return [...new Set(logins.filter((l): l is string => Boolean(l)).map((l) => l.toLowerCase()))];
}
