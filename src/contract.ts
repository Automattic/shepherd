// Contract fixtures for a host that ports the data layer. Each case in contract/cases/ is the `data` of a batch detail
// query response (`pr0`, `dn0` and `up0`) for one invented PR. The build runs it through this server's own getDetail()
// and writes the input and the shaped PrDetail to dist/contract/. A port that shapes the same input must give the same output.
// The functions throw on a bad case; only the build command exits the process.

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ROOT } from './config.ts';
import type { GhRunner } from './gh.ts';
import { createPrService } from './prs.ts';
import { buildDetailBatch, DEFAULT_BRANCHES } from './queries.ts';
import type { Config, PrDetail } from './types.ts';

const CASES_DIR = join(ROOT, 'contract', 'cases');

/** What the cases are shaped with: the same context in every file. It has no names from a real config. */
const CONTEXT = {
	hosts: {
		ghe: { hostname: 'github.example.com', bot: 'review-bot' as string | null },
		github: { hostname: 'github.com', bot: null as string | null },
	},
	linear: { workspace: 'example', keys: [] as string[] },
};

// The context, plus the fields that Config needs and that the detail shape does not read.
// There are no repos, so `limitHours` is null, and no `reviewTeams` or `ignoreParticipants`.
const CONFIG: Config = {
	me: 'example',
	team: [],
	repos: [],
	hosts: Object.fromEntries(Object.entries(CONTEXT.hosts).map(([key, host]) => [key, { ...host, label: key }])),
	linear: CONTEXT.linear,
};

/** The time that every case has as `fetchedAt`, so that the output does not change from run to run. */
const FIXED_FETCHED_AT = '2000-01-01T00:00:00.000Z';

const COMPARE_ERROR = 'compare not available in contract';

export interface ContractCase {
	name: string;
	host: string;
	owner: string;
	repo: string;
	/** The PRs of the batch query. A case is a batch of one, and its PR is `pr0` in `data`. */
	prs: { number: number; head: string; base: string }[];
	/** The `data` of a batch detail query response. */
	data: { repository: Record<string, unknown> } & Record<string, unknown>;
}

export interface ContractFile {
	name: string;
	context: typeof CONTEXT;
	input: ContractCase;
	expected: PrDetail;
}

const CASE_KEYS = ['data', 'host', 'name', 'owner', 'prs', 'repo'];
const PR_KEYS = ['base', 'head', 'number'];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** Throws an error that names the case when `value`, the parsed content of the file `file`, is not a valid case. */
export function validateCase(value: unknown, file: string): ContractCase {
	const stem = basename(file, '.json');
	const bad = (message: string): never => {
		throw new Error(`contract case ${stem}: ${message}`);
	};
	if (!isObject(value)) return bad('is not an object');
	if (!isDeepStrictEqual(Object.keys(value).sort(), CASE_KEYS)) return bad(`has the keys ${Object.keys(value).sort().join(', ')}, not ${CASE_KEYS.join(', ')}`);
	if (value.name !== stem) return bad(`has the name ${JSON.stringify(value.name)}, which is not its file name`);
	if (!/^[a-z0-9-]+$/.test(stem)) return bad('has a file name with a character outside a-z, 0-9 and -');
	if (typeof value.host !== 'string' || !Object.hasOwn(CONTEXT.hosts, value.host)) return bad(`has a host that is not one of ${Object.keys(CONTEXT.hosts).join(', ')}`);
	// owner and repo go into a REST path, and the shaping skips the base age when they do not match this.
	for (const key of ['owner', 'repo'] as const) if (typeof value[key] !== 'string' || !/^[\w.-]+$/.test(value[key])) return bad(`has a ${key} that is not a name`);
	const pr = Array.isArray(value.prs) && value.prs.length === 1 ? value.prs[0] : undefined;
	if (!isObject(pr)) return bad('has no prs list with exactly one PR');
	if (!isDeepStrictEqual(Object.keys(pr).sort(), PR_KEYS)) return bad(`has a PR with the keys ${Object.keys(pr).sort().join(', ')}, not ${PR_KEYS.join(', ')}`);
	if (!Number.isInteger(pr.number) || (pr.number as number) < 1) return bad('has a number that is not a positive integer');
	if (!isText(pr.head) || !isText(pr.base)) return bad('has no head or no base branch name');
	const repository = isObject(value.data) ? value.data.repository : undefined;
	if (!isObject(repository)) return bad('has no data.repository object');
	// The batch has the aliases pr0, dn0 (the head is never empty) and up0, which only a base that is not a default branch has.
	const wantsParent = !DEFAULT_BRANCHES.has(pr.base as string);
	const want = wantsParent ? ['defaultBranchRef', 'dn0', 'pr0', 'up0'] : ['defaultBranchRef', 'dn0', 'pr0'];
	if (!isDeepStrictEqual(Object.keys(repository).sort(), want)) {
		return bad(`has the keys ${Object.keys(repository).sort().join(', ')} in data.repository, and a base of ${pr.base} needs ${want.join(', ')}`);
	}
	for (const key of ['pr0', 'dn0', ...(wantsParent ? ['up0'] : [])]) if (!isObject(repository[key])) return bad(`has a data.repository.${key} that is not an object`);
	return value as unknown as ContractCase;
}

/** Reads and checks every case in `dir`, in name order. Throws when a case is not valid or when there is none. */
export async function loadCases(dir: string = CASES_DIR): Promise<ContractCase[]> {
	const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
	if (files.length === 0) throw new Error(`No contract cases in ${dir}`);
	const cases: ContractCase[] = [];
	for (const file of files) {
		let value: unknown;
		try {
			value = JSON.parse(await readFile(join(dir, file), 'utf8'));
		} catch (e) {
			throw new Error(`contract case ${basename(file, '.json')}: ${(e as Error).message}`);
		}
		cases.push(validateCase(value, file));
	}
	return cases;
}

/**
 * A `gh` that answers only the batch detail query of this case, with the case data. It rejects any other query text,
 * any other variables, and every REST call, so that a case cannot pass by getting another answer than GitHub gives.
 */
export function contractGh(c: ContractCase): GhRunner {
	return {
		rate: {},
		async query<T>(hostKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
			if (query !== buildDetailBatch({ owner: c.owner, name: c.repo, prs: c.prs }).query) {
				throw new Error(`contract case ${c.name}: the fake answers only the batch query of its case`);
			}
			// The variables are written out here and not taken from the builder, so that this check does not follow the builder.
			const [pr] = c.prs as [ContractCase['prs'][number]];
			const wantsParent = !DEFAULT_BRANCHES.has(pr.base);
			const want = { owner: c.owner, name: c.repo, n0: pr.number, h0: pr.head, ...(wantsParent ? { b0: pr.base } : {}) };
			if (hostKey !== c.host || !isDeepStrictEqual(variables, want)) {
				throw new Error(`contract case ${c.name}: the fake got ${hostKey} ${JSON.stringify(variables)}, not ${c.host} ${JSON.stringify(want)}`);
			}
			if (wantsParent !== ('up0' in c.data.repository)) {
				throw new Error(`contract case ${c.name}: data.repository has ${wantsParent ? 'no' : 'an'} up0, and a base of ${pr.base} means ${wantsParent ? 'one' : 'none'}`);
			}
			return structuredClone(c.data) as T;
		},
		get: () => Promise.reject(new Error(COMPARE_ERROR)),
	};
}

/** Runs one case through a new service of this server's data layer and returns the file content for it. */
export async function buildContract(c: ContractCase): Promise<ContractFile> {
	const service = createPrService(CONFIG, contractGh(c));
	const [pr] = c.prs as [ContractCase['prs'][number]];
	let detail: PrDetail;
	try {
		detail = await service.getDetail({ host: c.host, owner: c.owner, repo: c.repo, number: pr.number, head: pr.head, base: pr.base });
	} catch (e) {
		throw new Error(`contract case ${c.name}: ${(e as Error).message}`);
	}
	const file: ContractFile = { name: c.name, context: CONTEXT, input: c, expected: { ...detail, fetchedAt: FIXED_FETCHED_AT } };
	return JSON.parse(JSON.stringify(file)) as ContractFile;
}

/** The content of every file in dist/contract/, in case name order. */
export async function buildContracts(dir: string = CASES_DIR): Promise<ContractFile[]> {
	const out: ContractFile[] = [];
	for (const c of await loadCases(dir)) out.push(await buildContract(c));
	return out;
}
