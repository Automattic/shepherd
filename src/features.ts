// Dashboard features that a server can turn off, shared by the server and the browser client.

/** The features that a server can turn off, and that config.json and the personal settings can turn off. */
export const FEATURES = ['shipped', 'followups', 'herdr'] as const;
export type Feature = (typeof FEATURES)[number];
/** `settings`: the server has GET and PUT /api/settings. Unlike the other features, it is off unless the server sends `true`. */
export type Features = Record<Feature, boolean> & { settings: boolean };

export const isFeature = (v: string): v is Feature => (FEATURES as readonly string[]).includes(v);

/**
 * Turns a `features` object from a server into a full set of switches.
 * A missing object, a missing key or a value that is not `false` means on.
 * Follow-ups show only in the Shipped section, so they are off when Shipped is off.
 * `settings` is the exception: only `true` means on, so a server that has no settings API gets no requests for it.
 */
export function resolveFeatures(v: unknown): Features {
	const f = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
	const shipped = f.shipped !== false;
	return { shipped, followups: shipped && f.followups !== false, herdr: f.herdr !== false, settings: f.settings === true };
}
