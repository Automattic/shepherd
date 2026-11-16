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
	/** `true` adds a `/` to the end of the path of each API call to `apiBase`, before the query. Default: `false`. */
	apiTrailingSlash?: boolean;
}

/** The mount element of the standalone page (public/index.html). */
export const DEFAULT_MOUNT = '#shepherd';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A fixed origin to parse a path against. A path that resolves to a different origin is not a path.
const PATH_ORIGIN = 'http://path.invalid';

/**
 * A path on this origin ("/x/api") or an http(s) URL. Other values give `undefined`.
 * The URL parser changes `\` to `/` and removes tabs and newlines, so "/\evil.example" goes to
 * another origin. Thus the check parses the value. It also rejects a query, a fragment and a
 * user name or password, because these values break every call.
 */
function readApiBase(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	const raw = v.trim();
	if (/[\\\s?#]/.test(raw)) return undefined;
	const isPath = raw.startsWith('/');
	// `fetch()` resolves "http:/x" against the page when the scheme is the same, so a URL must have "//".
	if (!isPath && !/^https?:\/\//i.test(raw)) return undefined;
	let url: URL;
	try {
		url = isPath ? new URL(raw, PATH_ORIGIN) : new URL(raw);
	} catch {
		return undefined;
	}
	if (isPath ? url.origin !== PATH_ORIGIN : url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
	if (url.username || url.password) return undefined;
	return raw.replace(/\/+$/, '');
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
	if (typeof raw.apiTrailingSlash === 'boolean') opts.apiTrailingSlash = raw.apiTrailingSlash;
	return opts;
}

/**
 * Replaces the `/api` prefix of `path` with `apiBase`. Other paths do not change.
 * With `trailingSlash`, the path of the new URL ends with `/`, before the query. Some hosts
 * redirect a path without the slash, and each redirect costs one more request.
 */
export function apiUrl(path: string, apiBase: string | undefined, trailingSlash = false): string {
	if (apiBase === undefined) return path;
	if (path !== '/api' && !path.startsWith('/api/') && !path.startsWith('/api?')) return path;
	const url = apiBase + path.slice(4);
	if (!trailingSlash) return url;
	const q = url.indexOf('?');
	const [route, query] = q === -1 ? [url, ''] : [url.slice(0, q), url.slice(q)];
	return (route.endsWith('/') ? route : route + '/') + query;
}

/**
 * True when the client may send its bearer token to `apiBase`: the default `/api`, a path, or a URL
 * on the page's own origin. The token belongs to this origin, so a URL on another origin (or the
 * same host over another scheme or port) never gets it. That server needs its own `headers`.
 */
export function sendsToken(apiBase: string | undefined, pageOrigin: string): boolean {
	// readApiBase() keeps only paths on this origin, and turns "/" (the API at the root) into "".
	// A page with an opaque origin ("null") still sends it to them.
	if (apiBase === undefined || apiBase === '' || (apiBase.startsWith('/') && !apiBase.startsWith('//'))) return true;
	try {
		return new URL(apiBase).origin === pageOrigin;
	} catch {
		return false;
	}
}

/**
 * The headers of one API call, in this order: the host's headers, then the headers of the call,
 * then the bearer token. The token is added only when no earlier header sets `Authorization`.
 */
export function apiHeaders(embedHeaders: Record<string, string> | undefined, callHeaders: HeadersInit | undefined, token: string): Headers {
	const headers = new Headers(embedHeaders);
	new Headers(callHeaders).forEach((value, name) => headers.set(name, value));
	if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
	return headers;
}
