import { expect, test } from 'bun:test';
import { apiHeaders, apiUrl, readEmbedOptions, sendsToken } from './embed.ts';

test('readEmbedOptions gives no options when window.SHEPHERD is not an object', () => {
	for (const raw of [undefined, null, 'x', 42, true, ['/x']]) expect(readEmbedOptions(raw)).toEqual({});
});

test('readEmbedOptions keeps a valid apiBase without the trailing slash', () => {
	expect(readEmbedOptions({ apiBase: '/my-app/api/shepherd/' })).toEqual({ apiBase: '/my-app/api/shepherd' });
	expect(readEmbedOptions({ apiBase: ' /x ' })).toEqual({ apiBase: '/x' });
	expect(readEmbedOptions({ apiBase: 'https://example.com/shepherd' })).toEqual({ apiBase: 'https://example.com/shepherd' });
});

test('readEmbedOptions ignores an apiBase that is not valid', () => {
	for (const apiBase of ['', 'relative/path', '//evil.example/api', 'javascript:alert(1)', 42, null, {}]) {
		expect(readEmbedOptions({ apiBase })).toEqual({});
	}
});

test('readEmbedOptions ignores a path apiBase that the URL parser sends to another origin', () => {
	for (const apiBase of ['/\\evil.example/api', '/\t/evil.example/api', '/\n/evil.example', '/\r/evil.example', '/ /x']) {
		expect(readEmbedOptions({ apiBase })).toEqual({});
	}
});

test('readEmbedOptions ignores an http(s) apiBase without "//"', () => {
	for (const apiBase of ['http:/evil.example', 'https:evil.example/s', 'https:/evil.example']) {
		expect(readEmbedOptions({ apiBase })).toEqual({});
	}
	expect(readEmbedOptions({ apiBase: 'HTTPS://example.com/s' })).toEqual({ apiBase: 'HTTPS://example.com/s' });
});

test('readEmbedOptions ignores an apiBase with a query, a fragment or credentials', () => {
	for (const apiBase of ['/x?a=1', '/x?', '/x#f', 'https://example.com/s?a=1', 'https://u:p@example.com/s', 'https://u@example.com/s']) {
		expect(readEmbedOptions({ apiBase })).toEqual({});
	}
});

test('readEmbedOptions keeps only valid headers with string values', () => {
	const opts = readEmbedOptions({
		headers: { 'X-Nonce': 'abc', 'X-Number': 1, 'bad name': 'x', 'X-Bad-Value': 'a\nb', 'X-Csrf': '' },
	});
	expect(opts).toEqual({ headers: { 'X-Nonce': 'abc', 'X-Csrf': '' } });
	expect(readEmbedOptions({ headers: ['X-Nonce', 'abc'] })).toEqual({});
	expect(readEmbedOptions({ headers: { 'X-Number': 1 } })).toEqual({});
});

test('apiUrl replaces only the /api prefix', () => {
	expect(apiUrl('/api/prs?reviewers=a', undefined)).toBe('/api/prs?reviewers=a');
	expect(apiUrl('/api/prs?reviewers=a', '/my-app/api/shepherd')).toBe('/my-app/api/shepherd/prs?reviewers=a');
	expect(apiUrl('/api/herdr/focus', 'https://example.com/s')).toBe('https://example.com/s/herdr/focus');
	expect(apiUrl('/api', '/x')).toBe('/x');
	expect(apiUrl('/apis/x', '/x')).toBe('/apis/x');
	expect(apiUrl('/app.js', '/x')).toBe('/app.js');
});

test('apiUrl adds a trailing slash before the query only when asked', () => {
	expect(apiUrl('/api/prs?reviewers=a', '/wp-json/x/v1', true)).toBe('/wp-json/x/v1/prs/?reviewers=a');
	expect(apiUrl('/api/config', '/wp-json/x/v1', true)).toBe('/wp-json/x/v1/config/');
	expect(apiUrl('/api', '/wp-json/x/v1', true)).toBe('/wp-json/x/v1/');
	expect(apiUrl('/api?a=1', '/x', true)).toBe('/x/?a=1');
	expect(apiUrl('/api/pr?u=https://e.com/a', 'https://example.com/s', true)).toBe('https://example.com/s/pr/?u=https://e.com/a');
	// Without apiBase, the local server gets its own paths, without a slash.
	expect(apiUrl('/api/prs?reviewers=a', undefined, true)).toBe('/api/prs?reviewers=a');
	expect(apiUrl('/app.js', '/x', true)).toBe('/app.js');
	expect(apiUrl('/api/prs?reviewers=a', '/x', false)).toBe('/x/prs?reviewers=a');
});

test('readEmbedOptions keeps a boolean apiTrailingSlash only', () => {
	expect(readEmbedOptions({ apiTrailingSlash: true })).toEqual({ apiTrailingSlash: true });
	expect(readEmbedOptions({ apiTrailingSlash: false })).toEqual({ apiTrailingSlash: false });
	expect(readEmbedOptions({ apiTrailingSlash: 'yes' })).toEqual({});
});

test('apiHeaders adds the host headers, then the call headers, then the token', () => {
	const h = apiHeaders({ 'X-Nonce': 'n', 'Content-Type': 'text/plain' }, { 'content-type': 'application/json' }, 'tok');
	expect(h.get('x-nonce')).toBe('n');
	expect(h.get('content-type')).toBe('application/json');
	expect(h.get('authorization')).toBe('Bearer tok');
});

test('apiHeaders keeps an Authorization header from the host or the call, in any case', () => {
	expect(apiHeaders({ AUTHORIZATION: 'Basic abc' }, undefined, 'tok').get('authorization')).toBe('Basic abc');
	expect(apiHeaders(undefined, [['Authorization', 'Basic call']], 'tok').get('authorization')).toBe('Basic call');
});

test('apiHeaders without options or a token gives only the call headers', () => {
	const h = apiHeaders(undefined, { 'content-type': 'application/json' }, '');
	expect([...h.keys()]).toEqual(['content-type']);
	expect([...apiHeaders(undefined, undefined, '').keys()]).toEqual([]);
});

test('readEmbedOptions keeps a mount selector and a boolean header', () => {
	expect(readEmbedOptions({ mount: '#shepherd', header: false })).toEqual({ mount: '#shepherd', header: false });
	expect(readEmbedOptions({ mount: ' .dash ', header: true })).toEqual({ mount: '.dash', header: true });
});

test('readEmbedOptions ignores a mount or header that is not valid', () => {
	for (const mount of ['', '   ', 42, null, {}, ['#x']]) expect(readEmbedOptions({ mount })).toEqual({});
	for (const header of ['false', 0, null, {}]) expect(readEmbedOptions({ header })).toEqual({});
});

test('sendsToken allows the default, a path and a URL on the page origin only', () => {
	const page = 'https://app.example';
	expect(sendsToken(undefined, page)).toBe(true);
	expect(sendsToken('/my-app/api', page)).toBe(true);
	expect(sendsToken('https://app.example/shepherd', page)).toBe(true);
	expect(sendsToken('HTTPS://APP.example:443/shepherd', page)).toBe(true);
	expect(sendsToken(undefined, 'null')).toBe(true);
	expect(sendsToken('/my-app/api', 'null')).toBe(true);
	expect(sendsToken('https://app.example/api', 'null')).toBe(false);
	for (const apiBase of ['https://other.example/api', 'http://app.example/api', 'https://app.example:8443/api', 'https://app.example.evil/api', '//other.example/api']) {
		expect(sendsToken(apiBase, page)).toBe(false);
	}
});
