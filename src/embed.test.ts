import { expect, test } from 'bun:test';
import { apiUrl, readEmbedOptions } from './embed.ts';

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

test('readEmbedOptions keeps a mount selector and a boolean header', () => {
	expect(readEmbedOptions({ mount: '#shepherd', header: false })).toEqual({ mount: '#shepherd', header: false });
	expect(readEmbedOptions({ mount: ' .dash ', header: true })).toEqual({ mount: '.dash', header: true });
});

test('readEmbedOptions ignores a mount or header that is not valid', () => {
	for (const mount of ['', '   ', 42, null, {}, ['#x']]) expect(readEmbedOptions({ mount })).toEqual({});
	for (const header of ['false', 0, null, {}]) expect(readEmbedOptions({ header })).toEqual({});
});
