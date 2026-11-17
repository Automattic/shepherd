// Keeps config.json as the local server's settings storage: reloads it when it changes on disk,
// and writes personal settings back to it safely (a temp file, then a rename).

import { createHash } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { problems, warnings } from './config.ts';
import { mergeHosts, mergePersonal } from './settings.ts';
import type { Config, DeploymentSettings, PersonalSettings } from './types.ts';

/** The file operations that the store uses. Tests replace some of them to make a write fail. */
export interface StoreFs {
	readFile(path: string): Promise<string>;
	/** Creates `path` (it must not exist) with `mode`, writes `text` and flushes it to the disk. */
	writeFile(path: string, text: string, mode?: number): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string): Promise<void>;
	/** The file that a path names, after symlinks. */
	realpath?(path: string): Promise<string>;
	/** The permission bits of a file. */
	mode?(path: string): Promise<number>;
	/** Flushes a folder, so a rename in it survives a crash. */
	syncDir?(path: string): Promise<void>;
}

const nodeFs: Required<StoreFs> = {
	readFile: (path) => readFile(path, 'utf8'),
	async writeFile(path, text, mode = 0o600) {
		// `wx`: never write through a file or a link that is already there.
		const handle = await open(path, 'wx', mode);
		try {
			await handle.writeFile(text, 'utf8');
			await handle.sync();
		} finally {
			await handle.close();
		}
	},
	rename,
	rm: (path) => rm(path, { force: true }),
	realpath: (path) => realpath(path),
	mode: async (path) => (await stat(path)).mode & 0o777,
	async syncDir(path) {
		const handle = await open(path, 'r');
		try {
			await handle.sync();
		} catch {
			// Some file systems cannot flush a folder; the rename itself is still atomic.
		} finally {
			await handle.close();
		}
	},
};

/** The version of a settings file: a hash of its bytes, so any change gives a new version. */
export const versionOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * The keys of config.json that only a restart applies. A reload keeps the values from startup. `hosts` is not one of them:
 * the server builds the `gh` runner again when the hosts change.
 */
const RESTART_KEYS = ['port', 'herdr', 'refresh', 'aiReviewLabel', 'ignoreParticipants', 'limits'] as const;

export class SettingsConflictError extends Error {}

export class SettingsWriteError extends Error {}

export interface ConfigStore {
	/** The config in use: the deployment settings from startup and the personal settings from the file. */
	readonly config: Config;
	/** The version of the file that `config` came from. */
	readonly version: string;
	/** Problems in the file on disk that kept a reload from applying, and settings that need a restart. */
	readonly problems: string[];
	/** Reads the file again when it may have changed. Returns true when `config` changed. */
	refresh(): Promise<boolean>;
	/**
	 * Writes personal settings, and the hosts' editable fields when `hosts` is given, when the file is still at
	 * `expectedVersion`. Throws SettingsConflictError when it is not, and SettingsWriteError when the write fails;
	 * the old file stays, with its mode, and a symlinked file stays a symlink.
	 */
	save(personal: PersonalSettings, expectedVersion: string, hosts?: DeploymentSettings['hosts']): Promise<void>;
	/** Calls `fn` with the new config after each reload or save that changed it. */
	onChange(fn: (config: Config) => void): void;
}

export interface ConfigStoreOptions {
	fs?: StoreFs;
	/** A reload reads the file at most once in this many ms. Default 1000. */
	minRefreshMs?: number;
}

/** A store for `file`, which loadConfig() has read and checked at startup (`text` and `config`). */
export function createConfigStore(file: string, text: string, config: Config, options: ConfigStoreOptions = {}): ConfigStore {
	const fs: Required<StoreFs> = { ...nodeFs, ...options.fs };
	const minRefreshMs = options.minRefreshMs ?? 1000;
	const startup = structuredClone(config);
	const listeners: ((c: Config) => void)[] = [];
	let current = config;
	let version = versionOf(text);
	// Why the file on disk did not apply (cleared when the file is good again), and the changes that need a restart.
	let diskProblems: string[] = [];
	let restartProblems: string[] = [];
	let lastRead = Date.now();
	// One read or write at a time, so a save checks and writes the same file.
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => {
		const p = queue.then(fn, fn);
		queue = p.catch(() => undefined);
		return p;
	};

	/** The file's config with the restart-only keys from startup. */
	function live(fromDisk: Config): { config: Config; restart: string[] } {
		const out = { ...fromDisk } as Record<string, unknown>;
		const restart: string[] = [];
		for (const key of RESTART_KEYS) {
			const start = (startup as unknown as Record<string, unknown>)[key];
			const disk = (fromDisk as unknown as Record<string, unknown>)[key];
			if (JSON.stringify(disk) !== JSON.stringify(start)) restart.push(key);
			if (start === undefined) delete out[key];
			else out[key] = start;
		}
		return { config: out as unknown as Config, restart };
	}

	function apply(nextText: string, parsed: Config): boolean {
		const { config: next, restart } = live(parsed);
		version = versionOf(nextText);
		diskProblems = [];
		restartProblems = restart.length ? [`config.json changed ${restart.join(', ')}; restart the server to apply ${restart.length > 1 ? 'them' : 'it'}`] : [];
		const notes = warnings(next);
		if (notes.length) console.warn(`${file} has settings to check:\n${notes.map((p) => `  - ${p}`).join('\n')}`);
		const changed = JSON.stringify(next) !== JSON.stringify(current);
		current = next;
		if (changed) for (const fn of listeners) fn(next);
		return changed;
	}

	async function readNow(): Promise<boolean> {
		lastRead = Date.now();
		let nextText: string;
		try {
			nextText = await fs.readFile(file);
		} catch (e) {
			diskProblems = [`could not read ${basename(file)}: ${(e as Error).message}`];
			return false;
		}
		if (versionOf(nextText) === version) {
			// Back to the file in use, after a broken edit or a failed read.
			diskProblems = [];
			return false;
		}
		let parsed: Config;
		try {
			parsed = JSON.parse(nextText) as Config;
		} catch (e) {
			diskProblems = [`${basename(file)} is not valid JSON: ${(e as Error).message}`];
			return false;
		}
		let issues: string[];
		try {
			issues = problems(parsed);
		} catch (e) {
			issues = [`${basename(file)} could not be checked: ${(e as Error).message}`];
		}
		if (issues.length) {
			// Keep serving the last good settings; GET /api/settings shows why the file did not apply.
			diskProblems = issues;
			return false;
		}
		return apply(nextText, parsed);
	}

	return {
		get config() {
			return current;
		},
		get version() {
			return version;
		},
		get problems() {
			return [...diskProblems, ...restartProblems];
		},
		refresh() {
			if (Date.now() - lastRead < minRefreshMs) return Promise.resolve(false);
			return serial(readNow);
		},
		save(personal, expectedVersion, hosts) {
			return serial(async () => {
				// Write to the file a symlink points to, so the link stays.
				const target = await fs.realpath(file).catch(() => file);
				const onDiskText = await fs.readFile(target);
				// The file changed on disk, or another tab saved first.
				if (versionOf(onDiskText) !== expectedVersion) {
					await readNow();
					throw new SettingsConflictError('config.json changed since these settings were loaded');
				}
				const onDisk = JSON.parse(onDiskText) as Record<string, unknown>;
				// The hosts first, so a host added in this save gets its review teams from mergePersonal.
				const nextText = `${JSON.stringify(mergePersonal(hosts ? mergeHosts(onDisk, hosts) : onDisk, personal), null, 2)}\n`;
				const parsed = JSON.parse(nextText) as Config;
				const issues = problems(parsed);
				if (issues.length) throw new SettingsWriteError(`the new config.json would have problems: ${issues.join('; ')}`);
				// The temp file is in the same folder, so the rename replaces the file in one step.
				const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.tmp`);
				try {
					// The new file keeps the mode of the old one, so a private config.json stays private.
					await fs.writeFile(tmp, nextText, await fs.mode(target).catch(() => 0o600));
					await fs.rename(tmp, target);
					await fs.syncDir(dirname(target)).catch(() => undefined);
				} catch (e) {
					await fs.rm(tmp).catch(() => undefined);
					throw new SettingsWriteError(`could not write ${basename(file)}: ${(e as Error).message}`);
				}
				lastRead = Date.now();
				apply(nextText, parsed);
			});
		},
		onChange(fn) {
			listeners.push(fn);
		},
	};
}
