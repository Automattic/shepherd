import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ROOT } from './config.ts';
import { buildContracts, contractGh, loadCases, validateCase, type ContractCase, type ContractFile } from './contract.ts';
import { DETAIL_PR_FIELDS, DETAIL_QUERY, MINI_PR_FIELDS, SEARCH_QUERY } from './queries.ts';

const CASES_DIR = join(ROOT, 'contract', 'cases');
const FIXED_FETCHED_AT = '2000-01-01T00:00:00.000Z';
const COMPARE_ERROR = 'compare not available in contract';

const cases = await loadCases();
const caseNamed = (name: string): ContractCase => {
	const c = cases.find((x) => x.name === name);
	if (!c) throw new Error(`no contract case named ${name}`);
	return c;
};
const files = await buildContracts();
const expectedOf = (name: string): ContractFile['expected'] => {
	const f = files.find((x) => x.name === name);
	if (!f) throw new Error(`no contract output named ${name}`);
	return f.expected;
};

test('every contract case has a valid shape', async () => {
	const fileNames = (await readdir(CASES_DIR)).filter((f) => f.endsWith('.json')).sort();
	expect(fileNames.length).toBeGreaterThanOrEqual(9);
	expect(cases.map((c) => c.name)).toEqual(fileNames.map((f) => basename(f, '.json')));
	for (const file of fileNames) {
		const c = JSON.parse(await readFile(join(CASES_DIR, file), 'utf8')) as ContractCase;
		const name = basename(file, '.json');
		expect([name, Object.keys(c).sort()]).toEqual([name, ['base', 'data', 'head', 'host', 'name', 'number', 'owner', 'repo']]);
		expect([name, c.name]).toEqual([name, name]);
		expect([name, /^[a-z0-9-]+$/.test(c.name)]).toEqual([name, true]);
		expect([name, ['ghe', 'github'].includes(c.host)]).toEqual([name, true]);
		for (const key of ['defaultBranchRef', 'pullRequest', 'stackedOnThis']) expect([name, key, key in c.data.repository]).toEqual([name, key, true]);
	}
});

test('a contract case whose name is not its file name is refused', () => {
	const c = caseNamed('merged-pr');
	expect(() => validateCase(c, join(CASES_DIR, 'merged-pr.json'))).not.toThrow();
	expect(() => validateCase({ ...c, name: 'other-name' }, join(CASES_DIR, 'merged-pr.json'))).toThrow(/merged-pr: .*not its file name/);
	expect(() => validateCase(c, join(CASES_DIR, 'closed-pr.json'))).toThrow(/closed-pr: .*not its file name/);
});

// ---- the cases answer the detail query ----

interface Sel {
	fields: Map<string, Sel | null>;
	on: Map<string, Sel>;
}

/** Parses a selection body: field names, nested selections and `... on Type { }`. Argument lists are skipped. */
function parseSelection(text: string): Sel {
	const toks = text.match(/\.\.\.|[{}]|\([^()]*\)|[A-Za-z_]\w*/g) ?? [];
	let i = 0;
	const parseSet = (): Sel => {
		const sel: Sel = { fields: new Map(), on: new Map() };
		while (i < toks.length && toks[i] !== '}') {
			if (toks[i] === '...') {
				i += 2; // `...` and `on`
				const type = toks[i++]!;
				i++; // `{`
				sel.on.set(type, parseSet());
				i++; // `}`
				continue;
			}
			const name = toks[i++]!;
			if (toks[i]?.startsWith('(')) i++;
			if (toks[i] === '{') {
				i++;
				sel.fields.set(name, parseSet());
				i++;
			} else {
				sel.fields.set(name, null);
			}
		}
		return sel;
	};
	return parseSet();
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Compares a response value with the selection that asked for it: no key that was not asked for, and every key that was.
 * A field of `... on Type` is required when the value says `__typename: Type`, and optional when the value has no __typename
 * (an author is a User, with a name, or a bot, without one). `covered` collects the paths that some value has.
 */
function check(value: unknown, sel: Sel, path: string, problems: string[], covered: Set<string>): void {
	if (value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) check(item, sel, path, problems, covered);
		return;
	}
	if (!isObject(value)) {
		problems.push(`${path} is not an object`);
		return;
	}
	const children = new Map(sel.fields);
	const required = new Set(sel.fields.keys());
	for (const [type, frag] of sel.on) {
		for (const [name, child] of frag.fields) {
			children.set(name, child);
			if (value.__typename === type) required.add(name);
		}
	}
	for (const key of Object.keys(value)) {
		if (!children.has(key)) problems.push(`${path}.${key} is not asked for`);
		else covered.add(`${path}.${key}`);
	}
	for (const key of required) if (!(key in value)) problems.push(`${path}.${key} is missing`);
	for (const [key, child] of children) if (child && key in value) check(value[key], child, `${path}.${key}`, problems, covered);
}

/** Every path of the selection that ends in a value, not in a nested selection. */
function leaves(sel: Sel, path: string): string[] {
	const all = new Map(sel.fields);
	for (const frag of sel.on.values()) for (const [name, child] of frag.fields) all.set(name, child);
	return [...all].flatMap(([name, child]) => (child ? leaves(child, `${path}.${name}`) : [`${path}.${name}`]));
}

test('every contract case answers every field the detail query asks for', () => {
	const detail = parseSelection(DETAIL_PR_FIELDS);
	const mini = parseSelection(MINI_PR_FIELDS);
	const problems: string[] = [];
	const covered = new Set<string>();
	const miniCovered = new Set<string>();
	for (const c of cases) {
		const note = (list: string[]) => list.map((p) => `${c.name}: ${p}`);
		const found: string[] = [];
		const { repository } = c.data;
		expect([c.name, Object.keys(c.data).filter((k) => k !== 'rateLimit')]).toEqual([c.name, ['repository']]);
		const wantsParent = !['trunk', 'main', 'master', 'develop'].includes(c.base);
		expect([c.name, 'parent' in repository]).toEqual([c.name, wantsParent]);
		expect([c.name, Object.keys(repository).sort()]).toEqual([c.name, (wantsParent ? ['defaultBranchRef', 'parent', 'pullRequest', 'stackedOnThis'] : ['defaultBranchRef', 'pullRequest', 'stackedOnThis'])]);
		check(repository.pullRequest, detail, 'pullRequest', found, covered);
		check(repository.defaultBranchRef, parseSelection('name target { oid }'), 'defaultBranchRef', found, new Set());
		for (const key of wantsParent ? ['parent', 'stackedOnThis'] : ['stackedOnThis']) {
			const list = repository[key] as { nodes: unknown[] };
			expect([c.name, key, Object.keys(list)]).toEqual([c.name, key, ['nodes']]);
			check(list.nodes, mini, key, found, miniCovered);
			for (const node of list.nodes) expect([c.name, key, Object.keys(node as object).sort()]).toEqual([c.name, key, ['author', 'number', 'title', 'url']]);
		}
		problems.push(...note(found));
	}
	expect(problems).toEqual([]);
	const uncovered = leaves(detail, 'pullRequest').filter((p) => !covered.has(p));
	expect(uncovered).toEqual([]);
	expect(leaves(mini, 'parent').map((p) => p.replace('parent.', '')).filter((p) => ![...miniCovered].some((m) => m.endsWith(`.${p}`)))).toEqual([]);
	// The check itself finds a missing field and an extra one.
	const broken = structuredClone(caseNamed('merged-pr').data.repository.pullRequest as Record<string, unknown>);
	delete broken.mergeable;
	broken.extra = 1;
	const found: string[] = [];
	check(broken, detail, 'pullRequest', found, new Set());
	expect(found.sort()).toEqual(['pullRequest.extra is not asked for', 'pullRequest.mergeable is missing']);
});

// ---- the fake gh ----

test('the contract fake answers only the detail query', async () => {
	const c = caseNamed('ai-review-bot');
	const vars = { owner: c.owner, name: c.repo, n: c.number, head: c.head, base: c.base, withParent: false };
	const gh = contractGh(c);
	expect(gh.rate).toEqual({});

	const answer = await gh.query<ContractCase['data']>(c.host, DETAIL_QUERY, vars);
	expect(answer).toEqual(c.data);
	expect(answer).not.toBe(c.data); // a copy: the service cannot change the case through it

	await expect(gh.query(c.host, SEARCH_QUERY, vars)).rejects.toThrow(/only the detail query/);
	await expect(gh.query(c.host, 'query { viewer { login } }', vars)).rejects.toThrow(/only the detail query/);
	await expect(gh.query(c.host, DETAIL_QUERY, { ...vars, n: c.number + 1 })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host, DETAIL_QUERY, { ...vars, withParent: true })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host, DETAIL_QUERY, { owner: c.owner, name: c.repo, n: c.number })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host, DETAIL_QUERY, { ...vars, extra: 1 })).rejects.toThrow(/the fake got/);
	await expect(gh.query('github', DETAIL_QUERY, vars)).rejects.toThrow(/the fake got/);
	await expect(gh.get(c.host, 'repos/example-org/app/compare/a...b')).rejects.toThrow(COMPARE_ERROR);

	// withParent must agree with the data: a stacked base needs a parent, and a default base must not have one.
	const stacked = caseNamed('stacked-pr');
	const stackedVars = { owner: stacked.owner, name: stacked.repo, n: stacked.number, head: stacked.head, base: stacked.base, withParent: true };
	await expect(contractGh(stacked).query(stacked.host, DETAIL_QUERY, stackedVars)).resolves.toEqual(stacked.data);
	const { parent: _parent, ...noParent } = stacked.data.repository;
	await expect(contractGh({ ...stacked, data: { ...stacked.data, repository: noParent } }).query(stacked.host, DETAIL_QUERY, stackedVars)).rejects.toThrow(/has no parent/);
	await expect(contractGh({ ...c, data: { ...c.data, repository: { ...c.data.repository, parent: { nodes: [] } } } }).query(c.host, DETAIL_QUERY, vars)).rejects.toThrow(/has a parent/);
});

test('contract output is the same on every run', async () => {
	const first = await buildContracts();
	const second = await buildContracts();
	expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	expect(first).toHaveLength(cases.length);
	for (const f of first) expect([f.name, f.expected.fetchedAt]).toEqual([f.name, FIXED_FETCHED_AT]);
	// The context is the same literal in every file, and the case is passed through unchanged.
	const context = {
		hosts: { ghe: { hostname: 'github.example.com', bot: 'review-bot' }, github: { hostname: 'github.com', bot: null } },
		linear: { workspace: 'example', keys: [] },
	};
	for (const f of first) {
		expect([f.name, f.context]).toEqual([f.name, context]);
		expect([f.name, Object.keys(f)]).toEqual([f.name, ['name', 'context', 'input', 'expected']]);
		expect([f.name, f.input]).toEqual([f.name, caseNamed(f.name)]);
	}
});

test('every contract case shapes without an error', () => {
	expect(files.map((f) => f.name)).toEqual(cases.map((c) => c.name));
	for (const c of cases) {
		const e = expectedOf(c.name);
		expect([c.name, e.key, e.number]).toEqual([c.name, `${c.host}:${c.owner}/${c.repo}#${c.number}`, c.number]);
	}
});

// ---- shaped values, one test for each group of cases ----

test('contract: AI-review bot findings', () => {
	const bot = expectedOf('ai-review-bot').bot!;
	expect(bot.login).toBe('review-bot');
	expect(bot.open).toBe(8);
	expect(bot.blocking).toBe(4);
	expect(bot.outdated).toBe(1);
	expect(bot.bySeverity).toEqual({ critical: 1, high: 2, medium: 2, low: 2, info: 1 });
	const summary = bot.findings.map((f) => [f.title, f.severity, f.kind, f.category, f.belowThreshold, f.outdated]);
	expect(summary).toEqual([
		['Missing null check', 'critical', 'fix here', 'error handling', false, false], // the category is from the marker
		['Unbounded loop', 'high', 'fix here', null, false, false],
		['Unchecked input', 'medium', 'follow-up', null, false, false],
		['Long function', 'low', 'fix here', null, false, false],
		['Typo in comment', 'info', 'finding', null, false, false], // no tags
		['Rename variable', 'low', 'nit', null, false, false],
		['Consider caching', 'medium', 'fix here', null, true, false], // below the threshold
		['Stale check', 'high', 'fix here', null, false, true],
	]);
	// A resolved thread and a thread that the bot did not start are left out.
	expect(bot.findings.map((f) => f.title)).not.toContain('Already fixed');
	expect(bot.findings.map((f) => f.title)).not.toContain('Please rename this.');
	expect(bot.findings[0]).toEqual({
		title: 'Missing null check',
		severity: 'critical',
		kind: 'fix here',
		category: 'error handling',
		belowThreshold: false,
		outdated: false,
		url: 'https://github.example.com/example-org/app/pull/101#discussion_r1',
		path: 'src/a.ts',
		line: 10,
		createdAt: '2026-11-10T10:01:00Z',
	});
	// A host without a bot has no summary.
	expect(expectedOf('merged-pr').bot).toBeNull();
});

test('contract: review requests and reviews', () => {
	const e = expectedOf('reviews-and-requests');
	expect(e.requested.users).toEqual([
		{ login: 'bob', name: 'Bob Example' },
		{ login: 'carol', name: null },
	]);
	expect(e.requested.teams).toEqual([{ slug: 'core-reviewers', combinedSlug: 'example-org/core-reviewers', name: 'Core Reviewers', reviewTeam: false }]);
	expect(e.reviews).toEqual([
		{ login: 'dana', state: 'APPROVED', submittedAt: '2026-11-10T11:00:00Z' },
		{ login: 'ghost', state: 'CHANGES_REQUESTED', submittedAt: '2026-11-10T12:00:00Z' }, // a deleted account
		{ login: 'erin', state: 'DISMISSED', submittedAt: null },
	]);
	expect(e.reviewDecision).toBe('CHANGES_REQUESTED');
	expect(expectedOf('draft-ghost-author').author).toEqual({ login: 'ghost', name: null });
});

test('contract: participants', () => {
	const e = expectedOf('participants');
	// Newest first. No author (alice), and no bot: dependabot[bot], deploy-bot and review-bot are all newer than carol.
	expect(e.participants.map((p) => p.login)).toEqual(['carol', 'erin', 'dana', 'bob']);
	expect(e.participants).toEqual([
		{ login: 'carol', name: 'Carol Example', lastActive: '2026-11-10T11:00:00Z' },
		{ login: 'erin', name: null, lastActive: '2026-11-10T10:30:00Z' },
		{ login: 'dana', name: 'Dana Example', lastActive: '2026-11-10T10:00:00Z' },
		{ login: 'bob', name: 'Bob Example', lastActive: '2026-11-10T09:00:00Z' },
	]);
	expect(e.lastActivity).toEqual({ login: 'carol', at: '2026-11-10T11:00:00Z', kind: 'review' });
	expect(e.authorLastActive).toBe('2026-11-09T08:00:00Z');
	expect(e.lastCommitAt).toBe('2026-11-10T13:15:00Z');
});

test('contract: links and references', () => {
	const e = expectedOf('links-and-refs');
	expect(e.refs).toEqual([
		{ key: 'ghe:example-org/lib#12', host: 'ghe', owner: 'example-org', repo: 'lib', number: 12, url: 'https://github.example.com/example-org/lib/pull/12' },
		{ key: 'github:octocat/hello-world#34', host: 'github', owner: 'octocat', repo: 'hello-world', number: 34, url: 'https://github.com/octocat/hello-world/pull/34' },
	]);
	expect(e.hashRefs).toEqual([123, 45]);
	expect(e.linear).toEqual(['ENG-101']);
});

test('contract: fork, merged, draft and empty lists', () => {
	const unknown = { against: 'trunk', mergeBaseAt: null, behindBy: null, limitHours: null, error: COMPARE_ERROR };

	const fork = expectedOf('fork-pr');
	expect(fork.fork).toBe('contributor');
	expect(fork.state).toBe('OPEN');
	expect(fork.baseAge).toEqual(unknown); // open: the compare call failed, so the age is unknown

	const merged = expectedOf('merged-pr');
	expect(merged.state).toBe('MERGED');
	expect(merged.mergedAt).toBe('2026-11-10T13:30:00Z');
	expect(merged.fork).toBeNull();
	expect(merged.baseAge).toBeNull();
	expect(expectedOf('closed-pr').state).toBe('CLOSED');
	expect(expectedOf('closed-pr').baseAge).toBeNull();

	const draft = expectedOf('draft-ghost-author');
	expect(draft.isDraft).toBe(true);
	expect(draft.checks).toBeNull();
	expect(draft.baseAge).toEqual(unknown);
	expect(draft.requested).toEqual({ users: [], teams: [] });
	expect(draft.reviews).toEqual([]);
	expect(draft.participants).toEqual([]);
	expect(draft.refs).toEqual([]);
	expect(draft.hashRefs).toEqual([]);
	expect(draft.linear).toEqual([]);
	expect(draft.stackedOnThis).toEqual([]);
	expect(draft.parent).toBeNull();
	expect(draft.lastActivity).toBeNull();
	expect(draft.authorLastActive).toBeNull();
	expect(draft.lastCommitAt).toBeNull();
});

test('contract: stacked PR', () => {
	const e = expectedOf('stacked-pr');
	expect(e.parent).toEqual({ number: 109, title: 'Add the base API', url: 'https://github.com/example-org/app/pull/109', author: 'bob' });
	expect(e.stackedOnThis).toEqual([
		{ number: 111, title: 'Add the dashboard on top', url: 'https://github.com/example-org/app/pull/111', author: 'carol' },
		{ number: 112, title: 'Add docs on top', url: 'https://github.com/example-org/app/pull/112', author: 'ghost' },
	]);
	// A stacked PR is measured against the default branch, not against its parent's branch.
	expect(e.baseAge).toEqual({ against: 'trunk', mergeBaseAt: null, behindBy: null, limitHours: null, error: COMPARE_ERROR });
	expect(expectedOf('merged-pr').parent).toBeNull();
});
