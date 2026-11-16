import { afterEach, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClient, bundle } from './build-client.ts';

const startDir = process.cwd();
afterEach(() => process.chdir(startDir));

test('the minified build gives the same source paths from any folder', async () => {
	const fromRoot = await buildClient({ minify: true });
	process.chdir(tmpdir());
	const fromTmp = await buildClient({ minify: true });
	const sources = (b: { map?: string }): string[] => (JSON.parse(b.map!) as { sources: string[] }).sources;
	expect(sources(fromTmp)).toEqual(sources(fromRoot));
	expect(sources(fromTmp)).toContain('web/app.ts');
	expect(sources(fromTmp).every((s) => !s.startsWith('..') && !s.startsWith('/'))).toBe(true);
	expect(fromTmp.js.endsWith('//# sourceMappingURL=app.js.map\n')).toBe(true);
});

test('a failed build throws with the build logs and does not exit the process', async () => {
	await expect(bundle({ entrypoints: [join(tmpdir(), 'shepherd-no-such-entry.ts')], target: 'browser' })).rejects.toThrow(/Could not bundle/);
});
