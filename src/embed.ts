// Options that a host page gives to the browser client when it embeds the client.
// The host sets `window.SHEPHERD` before `app.js` loads. The client reads the object
// one time, at start, with `readEmbedOptions()`. Add new options to this interface and
// to that function, so that all of them have the same checks in one place.

export interface ShepherdEmbedOptions {
	/** Replaces the `/api` prefix of each API path. No trailing slash. */
	apiBase?: string;
	/** Added to each API request. */
	headers?: Record<string, string>;
	/** The element to render the dashboard into: a CSS selector or an element. Default: `#shepherd`. */
	mount?: string | Element;
	/** `false` hides the brand header. The controls stay. Default: `true`. */
	header?: boolean;
}

/** The mount element of the standalone page (public/index.html). */
export const DEFAULT_MOUNT = '#shepherd';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A path on this origin ("/x/api") or an http(s) URL. Other values give `undefined`. */
function readApiBase(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const base = v.trim().replace(/\/+$/, '');
	if (v.trim().startsWith('/') && !v.trim().startsWith('//')) return base;
	try {
		const url = new URL(base);
		if (url.protocol === 'http:' || url.protocol === 'https:') return base;
	} catch {
		/* not a URL */
	}
	return undefined;
}

/** Keeps only the entries that `Headers` accepts, with a string value. */
function readHeaders(v: unknown): Record<string, string> | undefined {
	if (!isRecord(v)) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(v)) {
		if (typeof value !== 'string') continue;
		try {
			new Headers([[name, value]]);
		} catch {
			continue;
		}
		out[name] = value;
	}
	return Object.keys(out).length ? out : undefined;
}

/** A non-empty selector string or a DOM element. Other values give `undefined`. */
function readMount(v: unknown): string | Element | undefined {
	if (typeof v === 'string') return v.trim() || undefined;
	if (typeof Element !== 'undefined' && v instanceof Element) return v;
	return undefined;
}

/** Reads `window.SHEPHERD`. The client ignores a value that is not valid. */
export function readEmbedOptions(raw: unknown): ShepherdEmbedOptions {
	if (!isRecord(raw)) return {};
	const opts: ShepherdEmbedOptions = {};
	const apiBase = readApiBase(raw.apiBase);
	if (apiBase !== undefined) opts.apiBase = apiBase;
	const headers = readHeaders(raw.headers);
	if (headers) opts.headers = headers;
	const mount = readMount(raw.mount);
	if (mount !== undefined) opts.mount = mount;
	if (typeof raw.header === 'boolean') opts.header = raw.header;
	return opts;
}

/** Replaces the `/api` prefix of `path` with `apiBase`. Other paths do not change. */
export function apiUrl(path: string, apiBase: string | undefined): string {
	if (apiBase === undefined) return path;
	if (path === '/api' || path.startsWith('/api/') || path.startsWith('/api?')) return apiBase + path.slice(4);
	return path;
}
