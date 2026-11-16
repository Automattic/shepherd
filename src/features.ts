// Dashboard features that a server can turn off, shared by the server and the browser client.

/** The features that a server can turn off. */
export const FEATURES = ['shipped', 'followups', 'herdr'] as const;
export type Feature = (typeof FEATURES)[number];
export type Features = Record<Feature, boolean>;

export const isFeature = (v: string): v is Feature => (FEATURES as readonly string[]).includes(v);

/**
 * Turns a `features` object from a server into a full set of switches.
 * A missing object, a missing key or a value that is not `false` means on.
 * Follow-ups show only in the Shipped section, so they are off when Shipped is off.
 */
export function resolveFeatures(v: unknown): Features {
	const f = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
	const shipped = f.shipped !== false;
	return { shipped, followups: shipped && f.followups !== false, herdr: f.herdr !== false };
}
