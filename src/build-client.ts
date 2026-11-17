// Builds the browser client. The server calls buildClient() at startup.
// `bun run build:client` runs this file and writes a minified copy of the client to dist/ for a host that embeds it,
// plus queries.json (the GraphQL field sets) and contract/ (shaping fixtures) for a host that ports the data layer,
// and settings.schema.json (the settings rules) for a host that keeps settings in its own storage.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { ROOT } from './config.ts';
import { buildContracts } from './contract.ts';
import { queriesJson } from './queries.ts';
import { settingsSchemaJson } from './settings-schema.ts';

export const PUBLIC_DIR = join(ROOT, 'public');
const CLIENT_ENTRY = join(ROOT, 'web', 'app.ts');

export interface ClientBuildOptions {
	/**
	 * Minify app.js and put its source map in a separate app.js.map file.
	 * When false (the server's default), app.js is not minified and has an inline source map.
	 */
	minify?: boolean;
}

export interface ClientBundle {
	/** The text of app.js. */
	js: string;
	/** The text of app.js.map. Only a minified build has it; the other build has an inline source map. */
	map?: string;
}

/** Runs Bun.build and returns its outputs. Throws an error with the build logs when the build fails. */
export async function bundle(config: Parameters<typeof Bun.build>[0]): Promise<Bun.BuildArtifact[]> {
	const result = await Bun.build({ ...config, throw: false });
	if (!result.success || result.outputs.length === 0) {
		const where = (log: (typeof result.logs)[number]): string =>
			log.position ? `${log.position.file}:${log.position.line}:${log.position.column}: ` : '';
		throw new Error([`Could not bundle ${config.entrypoints.join(', ')}:`, ...result.logs.map((log) => where(log) + log.message)].join('\n'));
	}
	return result.outputs;
}

/** Bundles web/app.ts into the text of app.js, and of app.js.map when `minify` is true. */
export async function buildClient({ minify = false }: ClientBuildOptions = {}): Promise<ClientBundle> {
	const outputs = await bundle({
		entrypoints: [CLIENT_ENTRY],
		target: 'browser',
		minify,
		sourcemap: minify ? 'external' : 'inline',
	});
	const js = await outputs.find((o) => o.kind === 'entry-point')!.text();
	if (!minify) return { js };
	// Bun adds no sourceMappingURL comment when it does not write the files itself.
	const map = await outputs.find((o) => o.kind === 'sourcemap')?.text();
	return map ? { js: `${js}//# sourceMappingURL=app.js.map\n`, map: rootRelativeSources(map) } : { js };
}

/**
 * Bun writes each source path relative to the current folder. Write it relative to ROOT instead,
 * so that the map is the same from any folder and has no folder names of the machine that built it.
 */
function rootRelativeSources(mapText: string): string {
	const map = JSON.parse(mapText) as { sources: string[] };
	map.sources = map.sources.map((s) => relative(ROOT, resolve(s)).replaceAll('\\', '/'));
	return JSON.stringify(map);
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/**
 * `bun run build:client`: writes the minified client, its styles and index.html to dist/,
 * plus dist/queries.json and one dist/contract/<case>.json per case in contract/cases/.
 * It deletes dist/contract/ first, so a removed or renamed case leaves no file behind.
 */
async function writeDist(): Promise<void> {
	const outDir = join(ROOT, 'dist');
	const contractDir = join(outDir, 'contract');
	await mkdir(outDir, { recursive: true });
	await rm(contractDir, { recursive: true, force: true });
	const contracts = await buildContracts();
	await writeFile(join(outDir, 'queries.json'), jsonText(queriesJson()));
	await mkdir(contractDir, { recursive: true });
	for (const file of contracts) await writeFile(join(contractDir, `${file.name}.json`), jsonText(file));
	const client = await buildClient({ minify: true });
	await writeFile(join(outDir, 'app.js'), client.js);
	if (client.map) await writeFile(join(outDir, 'app.js.map'), client.map);
	const [styles] = await bundle({ entrypoints: [join(PUBLIC_DIR, 'styles.css')], minify: true });
	await writeFile(join(outDir, 'styles.css'), await styles!.text());
	await copyFile(join(PUBLIC_DIR, 'index.html'), join(outDir, 'index.html'));
	// The settings rulebook, for a host that validates PUT /api/settings itself (docs/embedding.md).
	await writeFile(join(outDir, 'settings.schema.json'), settingsSchemaJson());
	console.log(`Wrote app.js, app.js.map, styles.css, index.html, queries.json, settings.schema.json and ${contracts.length} files in contract/ to ${outDir}`);
}

if (import.meta.main) {
	try {
		// Bun puts a debugId in app.js and its map that depends on the current folder; build from ROOT so every folder gives the same files.
		process.chdir(ROOT);
		await writeDist();
	} catch (e) {
		console.error(e);
		process.exit(1);
	}
}
