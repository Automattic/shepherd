import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { ROOT } from './config.ts';
import { buildContracts, contractGh, loadCases, validateCase, type ContractCase, type ContractFile } from './contract.ts';
import { buildDetailBatch, DETAIL_PR_FIELDS, MINI_PR_FIELDS, SEARCH_QUERY } from './queries.ts';

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
/** The one PR of a case: a case is a batch of one. */
const prOf = (c: ContractCase) => c.prs[0]!;
/** The text of the batch query that a case answers. */
const queryOf = (c: ContractCase) => buildDetailBatch({ owner: c.owner, name: c.repo, prs: c.prs }).query;

test('every contract case is a batch response', async () => {
	const fileNames = (await readdir(CASES_DIR)).filter((f) => f.endsWith('.json')).sort();
	expect(fileNames.length).toBeGreaterThanOrEqual(9);
	expect(cases.map((c) => c.name)).toEqual(fileNames.map((f) => basename(f, '.json')));
	for (const file of fileNames) {
		const c = JSON.parse(await readFile(join(CASES_DIR, file), 'utf8')) as ContractCase;
		const name = basename(file, '.json');
		expect([name, Object.keys(c).sort()]).toEqual([name, ['data', 'host', 'name', 'owner', 'prs', 'repo']]);
		expect([name, c.name]).toEqual([name, name]);
		expect([name, /^[a-z0-9-]+$/.test(c.name)]).toEqual([name, true]);
		expect([name, ['ghe', 'github'].includes(c.host)]).toEqual([name, true]);
		expect([name, c.prs.length]).toEqual([name, 1]);
		expect([name, Object.keys(prOf(c)).sort()]).toEqual([name, ['base', 'head', 'number']]);
		expect([name, Object.keys(c.data).sort()]).toEqual([name, ['rateLimit', 'repository']]);
		expect([name, Object.keys(c.data.rateLimit as object).sort()]).toEqual([name, ['cost', 'limit', 'remaining', 'resetAt']]);
		// The head is never empty in a case, so there is a dn0; there is an up0 exactly when the base is not a default branch.
		const wantsUp = !['trunk', 'main', 'master', 'develop'].includes(prOf(c).base);
		expect([name, Object.keys(c.data.repository).sort()]).toEqual([name, wantsUp ? ['defaultBranchRef', 'dn0', 'pr0', 'up0'] : ['defaultBranchRef', 'dn0', 'pr0']]);
	}
});

test('a contract case whose name is not its file name is refused', () => {
	const c = caseNamed('merged-pr');
	expect(() => validateCase(c, join(CASES_DIR, 'merged-pr.json'))).not.toThrow();
	expect(() => validateCase({ ...c, name: 'other-name' }, join(CASES_DIR, 'merged-pr.json'))).toThrow(/merged-pr: .*not its file name/);
	expect(() => validateCase(c, join(CASES_DIR, 'closed-pr.json'))).toThrow(/closed-pr: .*not its file name/);
});

test('a contract case whose parent lookup disagrees with its base is refused', () => {
	const stacked = caseNamed('stacked-pr');
	const file = join(CASES_DIR, 'stacked-pr.json');
	expect(() => validateCase(stacked, file)).not.toThrow();
	// A stacked base needs an up0.
	const { up0: _up0, ...noParent } = stacked.data.repository;
	expect(() => validateCase({ ...stacked, data: { ...stacked.data, repository: noParent } }, file)).toThrow(/stacked-pr: .*up0/);
	// A default base must not have one.
	const plain = caseNamed('merged-pr');
	const plainFile = join(CASES_DIR, 'merged-pr.json');
	expect(() => validateCase({ ...plain, data: { ...plain.data, repository: { ...plain.data.repository, up0: { nodes: [] } } } }, plainFile)).toThrow(/merged-pr: .*up0/);
	// The base decides: the same data with a stacked base needs the up0, and with a default base it must not have it.
	expect(() => validateCase({ ...plain, prs: [{ ...prOf(plain), base: 'feature/base-work' }] }, plainFile)).toThrow(/merged-pr: .*up0/);
	expect(() => validateCase({ ...stacked, prs: [{ ...prOf(stacked), base: 'main' }] }, file)).toThrow(/stacked-pr: .*up0/);
	// A case that is a batch of more than one PR is refused: the contract is a batch of one.
	expect(() => validateCase({ ...plain, prs: [prOf(plain), prOf(plain)] }, plainFile)).toThrow(/merged-pr: .*exactly one PR/);
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
 * A field of `... on Type` is required when the value says `__typename: Type`, and optional when the value has no __typename.
 * `covered` collects the paths that some value has.
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
		const wantsParent = !['trunk', 'main', 'master', 'develop'].includes(prOf(c).base);
		expect([c.name, 'up0' in repository]).toEqual([c.name, wantsParent]);
		expect([c.name, Object.keys(repository).sort()]).toEqual([c.name, (wantsParent ? ['defaultBranchRef', 'dn0', 'pr0', 'up0'] : ['defaultBranchRef', 'dn0', 'pr0'])]);
		check(repository.pr0, detail, 'pr0', found, covered);
		check(repository.defaultBranchRef, parseSelection('name target { oid }'), 'defaultBranchRef', found, new Set());
		for (const key of wantsParent ? ['up0', 'dn0'] : ['dn0']) {
			const list = repository[key] as { nodes: unknown[] };
			expect([c.name, key, Object.keys(list)]).toEqual([c.name, key, ['nodes']]);
			check(list.nodes, mini, key, found, miniCovered);
			for (const node of list.nodes) expect([c.name, key, Object.keys(node as object).sort()]).toEqual([c.name, key, ['author', 'number', 'title', 'url']]);
		}
		problems.push(...note(found));
	}
	expect(problems).toEqual([]);
	const uncovered = leaves(detail, 'pr0').filter((p) => !covered.has(p));
	expect(uncovered).toEqual([]);
	expect(leaves(mini, 'up0').map((p) => p.replace('up0.', '')).filter((p) => ![...miniCovered].some((m) => m.endsWith(`.${p}`)))).toEqual([]);
	// The check itself finds a missing field and an extra one.
	const broken = structuredClone(caseNamed('merged-pr').data.repository.pr0 as Record<string, unknown>);
	delete broken.mergeable;
	broken.extra = 1;
	const found: string[] = [];
	check(broken, detail, 'pr0', found, new Set());
	expect(found.sort()).toEqual(['pr0.extra is not asked for', 'pr0.mergeable is missing']);
});

// ---- the fake gh ----

test('the contract fake answers only the batch query of its case', async () => {
	const c = caseNamed('ai-review-bot');
	const pr = prOf(c);
	const query = queryOf(c);
	const vars = { owner: c.owner, name: c.repo, n0: pr.number, h0: pr.head };
	const gh = contractGh(c);
	expect(gh.rate).toEqual({});

	const answer = await gh.query<ContractCase['data']>(c.host, query, vars);
	expect(answer).toEqual(c.data);
	expect(answer).not.toBe(c.data); // a copy: the service cannot change the case through it

	// Another query text: another query, a text that is not this batch, a batch of another size, a text that differs by a character.
	await expect(gh.query(c.host, SEARCH_QUERY, vars)).rejects.toThrow(/only the batch query of its case/);
	await expect(gh.query(c.host, 'query { viewer { login } }', vars)).rejects.toThrow(/only the batch query of its case/);
	const two = buildDetailBatch({ owner: c.owner, name: c.repo, prs: [pr, { ...pr, number: pr.number + 1 }] }).query;
	await expect(gh.query(c.host, two, vars)).rejects.toThrow(/only the batch query of its case/);
	await expect(gh.query(c.host, `${query} `, vars)).rejects.toThrow(/only the batch query of its case/);
	// Other variables: a number, a missing or an extra variable, a variable of the stacked lookup on a default base, another host.
	await expect(gh.query(c.host, query, { ...vars, n0: pr.number + 1 })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host, query, { owner: c.owner, name: c.repo, n0: pr.number })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host, query, { ...vars, extra: 1 })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host, query, { ...vars, b0: pr.base })).rejects.toThrow(/the fake got/);
	await expect(gh.query(c.host === 'github' ? 'ghe' : 'github', query, vars)).rejects.toThrow(/the fake got/);
	// Every REST call.
	await expect(gh.get(c.host, 'repos/example-org/app/compare/a...b')).rejects.toThrow(COMPARE_ERROR);

	// A stacked base has b0 in its variables, and its data must have an up0; a default base must not have one.
	const stacked = caseNamed('stacked-pr');
	const sPr = prOf(stacked);
	const stackedVars = { owner: stacked.owner, name: stacked.repo, n0: sPr.number, h0: sPr.head, b0: sPr.base };
	await expect(contractGh(stacked).query(stacked.host, queryOf(stacked), stackedVars)).resolves.toEqual(stacked.data);
	await expect(contractGh(stacked).query(stacked.host, queryOf(stacked), { ...stackedVars, b0: 'other' })).rejects.toThrow(/the fake got/);
	await expect(contractGh(stacked).query(stacked.host, queryOf(stacked), { owner: stacked.owner, name: stacked.repo, n0: sPr.number, h0: sPr.head })).rejects.toThrow(/the fake got/);
	const { up0: _up0, ...noParent } = stacked.data.repository;
	await expect(contractGh({ ...stacked, data: { ...stacked.data, repository: noParent } }).query(stacked.host, queryOf(stacked), stackedVars)).rejects.toThrow(/has no up0/);
	await expect(contractGh({ ...c, data: { ...c.data, repository: { ...c.data.repository, up0: { nodes: [] } } } }).query(c.host, query, vars)).rejects.toThrow(/has an up0/);
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
		expect([c.name, e.key, e.number]).toEqual([c.name, `${c.host}:${c.owner}/${c.repo}#${prOf(c).number}`, prOf(c).number]);
	}
});

// ---- bots ----

/** Every actor of a case's pr0: an object with a `__typename` of User or Bot and a login. */
function actors(value: unknown, out: { login: string; type: string }[] = []): { login: string; type: string }[] {
	if (Array.isArray(value)) for (const v of value) actors(v, out);
	else if (isObject(value)) {
		if ((value.__typename === 'User' || value.__typename === 'Bot') && typeof value.login === 'string') out.push({ login: value.login, type: value.__typename });
		for (const v of Object.values(value)) actors(v, out);
	}
	return out;
}

test('contract cases use the Bot type only for logins the shaping treats as bots', () => {
	// The login rules of the shaping, with the AI-review bot of the contract context (the same in every case).
	const byLogin = (login: string) => /\[bot\]$|-bot$|^app\//i.test(login);
	let typedOnly = 0;
	for (const c of cases) {
		const list = actors(c.data.repository.pr0);
		const e = expectedOf(c.name);
		const seen = new Set([...e.participants.map((p) => p.login), ...(e.lastActivity ? [e.lastActivity.login] : [])]);
		for (const { login, type } of list) {
			// A login that the rules know is typed Bot, and a login with no such shape is a bot only when it is typed Bot, in one case.
			if (byLogin(login)) expect([c.name, login, type]).toEqual([c.name, login, 'Bot']);
			if (type === 'Bot' && !byLogin(login)) {
				expect(c.name).toBe('bot-typed-actor');
				typedOnly++;
			}
			// A bot is never a participant and never the last activity.
			if (type === 'Bot') expect([c.name, login, seen.has(login)]).toEqual([c.name, login, false]);
		}
	}
	// The case has bots that only their type marks (github-actions and copilot-reviewer).
	expect(typedOnly).toBeGreaterThan(0);
});

test('contract: bots that only their type marks', () => {
	const e = expectedOf('bot-typed-actor');
	expect(e.participants).toEqual([{ login: 'bob', name: 'Bob Example', lastActive: '2026-11-10T10:00:00Z' }]);
	expect(e.lastActivity).toEqual({ login: 'bob', at: '2026-11-10T10:00:00Z', kind: 'comment' });
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
