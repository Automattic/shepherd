// The repo chips (keys and labels) for repos the config does not list, and the repos the page offers to add.
// Shared by the browser client and its tests.

export interface RepoId {
	host: string;
	owner: string;
	name: string;
}

/** The filter key of a repo, in the form of the PR keys: `host:owner/name`. Unique for each host, owner and name. */
export const repoKey = ({ host, owner, name }: RepoId): string => `${host}:${owner}/${name}`;

/**
 * The parts of a filter key. A key that an older version saved holds only the repo name.
 * For such a key, the host and the owner are empty.
 */
export function parseRepoKey(key: string): RepoId {
	const m = /^([^:/]+):([^/]+)\/(.+)$/.exec(key);
	return m ? { host: m[1]!, owner: m[2]!, name: m[3]! } : { host: '', owner: '', name: key };
}

/**
 * One label for each repo, in the same order.
 * The label is the name when no other repo has that name, and `owner/name` when two repos share the name.
 * When two repos also share `owner/name` (on different hosts), the label adds the host label.
 */
export function repoChipLabels(ids: RepoId[], hostLabel: (host: string) => string): string[] {
	const full = (r: RepoId): string => (r.owner ? `${r.owner}/${r.name}` : r.name);
	const tally = (keys: string[]): Map<string, number> => {
		const m = new Map<string, number>();
		for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
		return m;
	};
	const names = tally(ids.map((r) => r.name));
	const fulls = tally(ids.map(full));
	return ids.map((r) => {
		if (names.get(r.name) === 1) return r.name;
		if (fulls.get(full(r)) === 1 || !r.host) return full(r);
		return `${full(r)} (${hostLabel(r.host)})`;
	});
}

/**
 * The selected repo filter values that no chip shows, for example a repo that a saved filter holds but that
 * the config no longer lists. The page gives each one a chip with a count of 0, so that the user can clear it.
 */
export function unknownSelectedRepos(selected: string[], shown: string[]): string[] {
	return selected.filter((key) => !shown.includes(key));
}

/** The listed repo for a repo id, matched without case, or undefined. */
export function findListed<T extends RepoId>(listed: T[], id: RepoId): T | undefined {
	const l = (s: string) => s.toLowerCase();
	return listed.find((r) => r.host === id.host && l(r.owner) === l(id.owner) && l(r.name) === l(id.name));
}

/**
 * The repos of `ids` that `listed` lacks, once each, in label order. With a host in any-repo mode the list finds PRs
 * outside the listed repos; the page offers each of these repos as one to add ("Add more repos").
 */
export function unlistedRepos(ids: RepoId[], listed: RepoId[]): RepoId[] {
	const seen = new Map<string, RepoId>();
	for (const id of ids) if (!findListed(listed, id) && !seen.has(repoKey(id))) seen.set(repoKey(id), { host: id.host, owner: id.owner, name: id.name });
	return [...seen.values()].sort((a, b) => `${a.name}/${a.owner}`.localeCompare(`${b.name}/${b.owner}`));
}

/** The entry for a repo to add to `repos`: its short name is the repo name, or `owner/name` when a listed repo already has that short name. */
export function newRepoEntry(id: RepoId, listed: { short: string }[]): { host: string; owner: string; name: string; short: string } {
	const taken = (s: string) => listed.some((r) => r.short.toLowerCase() === s.toLowerCase());
	let short = taken(id.name) ? `${id.owner}/${id.name}` : id.name;
	for (let n = 2; taken(short); n++) short = `${id.owner}/${id.name} (${n})`;
	return { host: id.host, owner: id.owner, name: id.name, short };
}
