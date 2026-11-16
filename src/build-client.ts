// Builds the browser client. The server calls buildClient() at startup.
// `bun run build:client` runs this file and writes a copy of the client to dist/ for a host that embeds it.

import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from './config.ts';

export const PUBLIC_DIR = join(ROOT, 'public');
const CLIENT_ENTRY = join(ROOT, 'web', 'app.ts');

/** Bundles web/app.ts into the text of app.js. Exits the process with the build logs when the build fails. */
export async function buildClient(): Promise<string> {
	const result = await Bun.build({ entrypoints: [CLIENT_ENTRY], target: 'browser', sourcemap: 'inline' });
	const output = result.outputs[0];
	if (!result.success || !output) {
		console.error('Could not bundle the browser client:');
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	return output.text();
}

if (import.meta.main) {
	const outDir = join(ROOT, 'dist');
	await mkdir(outDir, { recursive: true });
	await writeFile(join(outDir, 'app.js'), await buildClient());
	for (const file of ['styles.css', 'index.html']) await copyFile(join(PUBLIC_DIR, file), join(outDir, file));
	console.log(`Wrote app.js, styles.css and index.html to ${outDir}`);
}
