// Keeps config.json as the local server's settings storage: reloads it when it changes on disk,
// and writes personal settings back to it safely (a temp file, then a rename).

import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { problems, warnings } from './config.ts';
import { mergePersonal } from './settings.ts';
import type { Config, PersonalSettings } from './types.ts';

/** The file operations that the store uses. Tests replace them to make a write fail. */
export interface StoreFs {
	readFile(path: string): Promise<string>;
	writeFile(path: string, text: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string): Promise<void>;
}

const nodeFs: StoreFs = {
	readFile: (path) => readFile(path, 'utf8'),
	writeFile: (path, text) => writeFile(path, text, 'utf8'),
	rename,
	rm: (path) => rm(path, { force: true }),
};

/** The version of a settings file: a hash of its bytes, so any change gives a new version. */
export const versionOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/**
 * The keys of config.json that only a restart applies. A reload keeps the values from startup,
 * because the `gh` runner, the port and herdr are built from them.
 */
const RESTART_KEYS = ['port', 'hosts', 'herdr', 'refresh', 'aiReviewLabel', 'ignoreParticipants', 'limits'] as const;

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
	 * Writes personal settings, when the file is still at `expectedVersion`.
	 * Throws SettingsConflictError when it is not, and SettingsWriteError when the write fails; the old file stays.
	 */
	save(personal: PersonalSettings, expectedVersion: string): Promise<void>;
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
	const fs = options.fs ?? nodeFs;
	const minRefreshMs = options.minRefreshMs ?? 1000;
	const startup = structuredClone(config);
	const listeners: ((c: Config) => void)[] = [];
	let current = config;
	let version = versionOf(text);
	let diskProblems: string[] = [];
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
			let disk = (fromDisk as unknown as Record<string, unknown>)[key];
			if (key === 'hosts') {
				// Review teams are personal: take them from the file, and the rest of each host from startup.
				const diskHosts = fromDisk.hosts;
				const merged = Object.fromEntries(
					Object.entries(startup.hosts).map(([k, h]) => {
						const { reviewTeams: _start, ...rest } = h;
						const teams = diskHosts[k]?.reviewTeams;
						return [k, teams ? { ...rest, reviewTeams: teams } : rest];
					})
				);
				const strip = (hosts: Config['hosts']) => Object.fromEntries(Object.entries(hosts).map(([k, { reviewTeams: _t, ...rest }]) => [k, rest]));
				disk = strip(diskHosts);
				if (JSON.stringify(disk) !== JSON.stringify(strip(startup.hosts))) restart.push(key);
				out.hosts = merged;
				continue;
			}
			if (JSON.stringify(disk) !== JSON.stringify(start)) restart.push(key);
			if (start === undefined) delete out[key];
			else out[key] = start;
		}
		return { config: out as unknown as Config, restart };
	}

	function apply(nextText: string, parsed: Config): boolean {
		const { config: next, restart } = live(parsed);
		version = versionOf(nextText);
		diskProblems = restart.length ? [`config.json changed ${restart.join(', ')}; restart the server to apply ${restart.length > 1 ? 'them' : 'it'}`] : [];
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
		if (versionOf(nextText) === version) return false;
		let parsed: Config;
		try {
			parsed = JSON.parse(nextText) as Config;
		} catch (e) {
			diskProblems = [`${basename(file)} is not valid JSON: ${(e as Error).message}`];
			return false;
		}
		const issues = problems(parsed);
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
			return diskProblems;
		},
		refresh() {
			if (Date.now() - lastRead < minRefreshMs) return Promise.resolve(false);
			return serial(readNow);
		},
		save(personal, expectedVersion) {
			return serial(async () => {
				const onDiskText = await fs.readFile(file);
				// The file changed on disk, or another tab saved first.
				if (versionOf(onDiskText) !== expectedVersion) {
					await readNow();
					throw new SettingsConflictError('config.json changed since these settings were loaded');
				}
				const onDisk = JSON.parse(onDiskText) as Record<string, unknown>;
				const nextText = `${JSON.stringify(mergePersonal(onDisk, personal), null, 2)}\n`;
				const parsed = JSON.parse(nextText) as Config;
				const issues = problems(parsed);
				if (issues.length) throw new SettingsWriteError(`the new config.json would have problems: ${issues.join('; ')}`);
				// The temp file is in the same folder, so the rename replaces the file in one step.
				const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
				try {
					await fs.writeFile(tmp, nextText);
					await fs.rename(tmp, file);
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
