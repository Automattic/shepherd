// Linear ticket keys, shared by the server (titles, branches and descriptions) and the browser client (titles and branches).

/** Escapes the characters that have a meaning in a regular expression. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/**
 * A pattern for `<KEY>-<number>` with the team keys of the settings, such as ENG-123. Each key is matched as plain text,
 * so a key that the schema would refuse (such as `OPS(`) never breaks the pattern or makes it slow. Null for no keys.
 */
export function linearKeyRegExp(keys: readonly string[]): RegExp | null {
	const plain = keys.map((k) => k.trim()).filter(Boolean);
	return plain.length ? new RegExp(`\\b(${plain.map(escapeRegExp).join('|')})-(\\d+)\\b`, 'gi') : null;
}
