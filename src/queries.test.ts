import { expect, test } from 'bun:test';
import {
	BATCH_MAX,
	BATCH_TEMPLATE,
	buildDetailBatch,
	DEFAULT_BRANCHES,
	DETAIL_PR_FIELDS,
	LIGHT_PR_FIELDS,
	MERGED_PR_FIELDS,
	MERGED_SEARCH_QUERY,
	MINI_PR_FIELDS,
	queriesJson,
	SEARCH_QUERY,
} from './queries.ts';
import { API_VERSION } from './types.ts';

// The queries as they were in src/prs.ts at commit 2f42e0b, before they were built from field sets.
// Written out in full, so that a change to a field set shows up as a difference here.
const BASE_SEARCH_QUERY = `query($q:String!, $after:String) {
	rateLimit { remaining limit resetAt cost }
	search(query:$q, type:ISSUE, first:100, after:$after) {
		issueCount pageInfo { hasNextPage endCursor }
		nodes { 
	... on PullRequest {
		number title url isDraft updatedAt createdAt headRefName baseRefName isCrossRepository headRepositoryOwner { login }
		author { login ... on User { name } }
		repository { name owner { login } }
	} }
	}
}`;

const BASE_MERGED_SEARCH_QUERY = `query($q:String!, $after:String) {
	rateLimit { remaining limit resetAt cost }
	search(query:$q, type:ISSUE, first:100, after:$after) {
		issueCount pageInfo { hasNextPage endCursor }
		nodes { ... on PullRequest { number title url mergedAt author { login } repository { name owner { login } } } }
	}
}`;

/** The tokens of a GraphQL text. Whitespace and commas do not count. */
const tokens = (text: string): string[] => text.match(/\$?[A-Za-z_]\w*|\.\.\.|[{}()\[\]:!@=]|\d+/g) ?? [];

// The detail query for a batch of PRs, written out in full. These are not built from the exported constants, so that a
// change to a field set or to the template shows up as a difference here. The same literals are the examples in queries.json.
const ONE_PR_DEFAULT_BASE = {
	name: 'one-pr-default-base',
	input: { owner: 'example-org', name: 'app', prs: [{ number: 101, head: 'feature/login', base: 'trunk' }] },
	variables: { owner: 'example-org', name: 'app', n0: 101, h0: 'feature/login' },
	query: `query($owner:String!, $name:String!, $n0:Int!, $h0:String!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		defaultBranchRef { name target { oid } }
		pr0: pullRequest(number:$n0) { ...DetailPr }
		dn0: pullRequests(baseRefName:$h0, first:10, states:[OPEN]) { nodes { ...MiniPr } }
	}
}
fragment DetailPr on PullRequest {
	number title url state merged mergedAt isDraft updatedAt createdAt
	headRefName baseRefName isCrossRepository headRepositoryOwner { login } headRefOid baseRefOid baseRef { target { oid } } body mergeable reviewDecision additions deletions changedFiles
	author { __typename login avatarUrl(size: 64) ... on User { name } }
	statusCheckRollup { state }
	reviewRequests(first:30) { nodes { requestedReviewer {
		__typename
		... on User { login name avatarUrl(size: 64) }
		... on Team { slug combinedSlug name }
	} } }
	latestOpinionatedReviews(first:30) { nodes { state submittedAt author { __typename login avatarUrl(size: 64) } } }
	participants(first:50) { totalCount nodes { login name avatarUrl(size: 64) } }
	comments(last:50) { nodes { author { __typename login } createdAt updatedAt } }
	reviews(last:50) { nodes { author { __typename login } submittedAt } }
	commits(last:50) { nodes { commit { committedDate author { user { login } } } } }
	reviewThreads(first:100) { nodes {
		isResolved isOutdated path line
		comments(first:1) { nodes { author { __typename login } body url createdAt } }
	} }}
fragment MiniPr on PullRequest { number title url author { login } }
`,
};

const ONE_PR_STACKED = {
	name: 'one-pr-stacked',
	input: { owner: 'example-org', name: 'app', prs: [{ number: 110, head: 'feature/stacked-ui', base: 'feature/base-work' }] },
	variables: { owner: 'example-org', name: 'app', n0: 110, h0: 'feature/stacked-ui', b0: 'feature/base-work' },
	query: `query($owner:String!, $name:String!, $n0:Int!, $h0:String!, $b0:String!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		defaultBranchRef { name target { oid } }
		pr0: pullRequest(number:$n0) { ...DetailPr }
		dn0: pullRequests(baseRefName:$h0, first:10, states:[OPEN]) { nodes { ...MiniPr } }
		up0: pullRequests(headRefName:$b0, first:1, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}) { nodes { ...MiniPr } }
	}
}
fragment DetailPr on PullRequest {
	number title url state merged mergedAt isDraft updatedAt createdAt
	headRefName baseRefName isCrossRepository headRepositoryOwner { login } headRefOid baseRefOid baseRef { target { oid } } body mergeable reviewDecision additions deletions changedFiles
	author { __typename login avatarUrl(size: 64) ... on User { name } }
	statusCheckRollup { state }
	reviewRequests(first:30) { nodes { requestedReviewer {
		__typename
		... on User { login name avatarUrl(size: 64) }
		... on Team { slug combinedSlug name }
	} } }
	latestOpinionatedReviews(first:30) { nodes { state submittedAt author { __typename login avatarUrl(size: 64) } } }
	participants(first:50) { totalCount nodes { login name avatarUrl(size: 64) } }
	comments(last:50) { nodes { author { __typename login } createdAt updatedAt } }
	reviews(last:50) { nodes { author { __typename login } submittedAt } }
	commits(last:50) { nodes { commit { committedDate author { user { login } } } } }
	reviewThreads(first:100) { nodes {
		isResolved isOutdated path line
		comments(first:1) { nodes { author { __typename login } body url createdAt } }
	} }}
fragment MiniPr on PullRequest { number title url author { login } }
`,
};

const THREE_PRS_MIXED_BASES = {
	name: 'three-prs-mixed-bases',
	input: { owner: 'example-org', name: 'app', prs: [{ number: 201, head: 'feature/a', base: 'trunk' }, { number: 202, head: 'feature/b', base: 'feature/a' }, { number: 203, head: 'fix/c', base: 'main' }] },
	variables: { owner: 'example-org', name: 'app', n0: 201, h0: 'feature/a', n1: 202, h1: 'feature/b', b1: 'feature/a', n2: 203, h2: 'fix/c' },
	query: `query($owner:String!, $name:String!, $n0:Int!, $h0:String!, $n1:Int!, $h1:String!, $b1:String!, $n2:Int!, $h2:String!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		defaultBranchRef { name target { oid } }
		pr0: pullRequest(number:$n0) { ...DetailPr }
		dn0: pullRequests(baseRefName:$h0, first:10, states:[OPEN]) { nodes { ...MiniPr } }
		pr1: pullRequest(number:$n1) { ...DetailPr }
		dn1: pullRequests(baseRefName:$h1, first:10, states:[OPEN]) { nodes { ...MiniPr } }
		up1: pullRequests(headRefName:$b1, first:1, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}) { nodes { ...MiniPr } }
		pr2: pullRequest(number:$n2) { ...DetailPr }
		dn2: pullRequests(baseRefName:$h2, first:10, states:[OPEN]) { nodes { ...MiniPr } }
	}
}
fragment DetailPr on PullRequest {
	number title url state merged mergedAt isDraft updatedAt createdAt
	headRefName baseRefName isCrossRepository headRepositoryOwner { login } headRefOid baseRefOid baseRef { target { oid } } body mergeable reviewDecision additions deletions changedFiles
	author { __typename login avatarUrl(size: 64) ... on User { name } }
	statusCheckRollup { state }
	reviewRequests(first:30) { nodes { requestedReviewer {
		__typename
		... on User { login name avatarUrl(size: 64) }
		... on Team { slug combinedSlug name }
	} } }
	latestOpinionatedReviews(first:30) { nodes { state submittedAt author { __typename login avatarUrl(size: 64) } } }
	participants(first:50) { totalCount nodes { login name avatarUrl(size: 64) } }
	comments(last:50) { nodes { author { __typename login } createdAt updatedAt } }
	reviews(last:50) { nodes { author { __typename login } submittedAt } }
	commits(last:50) { nodes { commit { committedDate author { user { login } } } } }
	reviewThreads(first:100) { nodes {
		isResolved isOutdated path line
		comments(first:1) { nodes { author { __typename login } body url createdAt } }
	} }}
fragment MiniPr on PullRequest { number title url author { login } }
`,
};

const GOLDENS = [ONE_PR_DEFAULT_BASE, ONE_PR_STACKED, THREE_PRS_MIXED_BASES];

test('the built queries match the queries at 2f42e0b', () => {
	expect(tokens(SEARCH_QUERY)).toEqual(tokens(BASE_SEARCH_QUERY));
	expect(tokens(MERGED_SEARCH_QUERY)).toEqual(tokens(BASE_MERGED_SEARCH_QUERY));
});

test('each built query contains its exported field set', () => {
	// The detail query is built from the template: its fragments hold the field sets, and a built query has each fragment once.
	expect(BATCH_TEMPLATE.fragments[0]!.text).toContain(DETAIL_PR_FIELDS);
	expect(BATCH_TEMPLATE.fragments[1]!.text).toContain(MINI_PR_FIELDS);
	const stacked = buildDetailBatch(ONE_PR_STACKED.input).query;
	expect(stacked).toContain(DETAIL_PR_FIELDS);
	expect(stacked.split(MINI_PR_FIELDS)).toHaveLength(2);
	expect(SEARCH_QUERY).toContain(LIGHT_PR_FIELDS);
	expect(MERGED_SEARCH_QUERY).toContain(MERGED_PR_FIELDS);
});

test('each exported field set is a bare selection body', () => {
	const sets = { DETAIL_PR_FIELDS, MINI_PR_FIELDS, LIGHT_PR_FIELDS, MERGED_PR_FIELDS };
	for (const [name, fields] of Object.entries(sets)) {
		const body = fields.trim();
		const balanced = (open: string, close: string): boolean => {
			let depth = 0;
			for (const ch of body) {
				if (ch === open) depth++;
				if (ch === close && --depth < 0) return false;
			}
			return depth === 0;
		};
		const withoutArguments = body.replace(/\([^()]*\)/g, '');
		expect([name, body.length > 0]).toEqual([name, true]);
		expect([name, body.startsWith('{')]).toEqual([name, false]); // no outer braces
		expect([name, /^\.\.\.\s*on\s+PullRequest\b/.test(body)]).toEqual([name, false]);
		expect([name, body.includes('$')]).toEqual([name, false]); // no variable
		expect([name, withoutArguments.includes(':')]).toEqual([name, false]); // no alias
		expect([name, balanced('{', '}'), balanced('(', ')')]).toEqual([name, true, true]);
	}
});

// ---- the detail field set ----

interface Node {
	name: string;
	args: string;
	children: Node[] | null;
}

/** Parses a selection body into a tree: a field, its argument list, and its nested selection. `... on Type` is a field of its own. */
function parseTree(text: string): Node[] {
	const toks = text.match(/\.\.\.\s*on\s+\w+|[{}]|\([^()]*\)|[A-Za-z_]\w*/g) ?? [];
	let i = 0;
	const set = (): Node[] => {
		const out: Node[] = [];
		while (i < toks.length && toks[i] !== '}') {
			const name = toks[i++]!.replace(/\s+/g, ' ');
			const args = toks[i]?.startsWith('(') ? toks[i++]! : '';
			let children: Node[] | null = null;
			if (toks[i] === '{') {
				i++;
				children = set();
				i++;
			}
			out.push({ name, args, children });
		}
		return out;
	};
	return set();
}

test('the detail field set has the fields a host needs', () => {
	const tree = parseTree(DETAIL_PR_FIELDS);
	/** The fields (with their arguments) of the selection at `path`. Throws when the path has no selection. */
	const at = (...path: string[]): string[] => {
		let level = tree;
		for (const segment of path) {
			const node = level.find((n) => n.name === segment);
			if (!node?.children) throw new Error(`the detail field set has no selection at ${path.join('.')}`);
			level = node.children;
		}
		return level.map((n) => n.name + n.args);
	};
	const avatar = 'avatarUrl(size: 64)';
	expect(at('author')).toContain(avatar);
	expect(at('reviewRequests', 'nodes', 'requestedReviewer', '... on User')).toContain(avatar);
	expect(at('latestOpinionatedReviews', 'nodes', 'author')).toContain(avatar);
	expect(at('participants', 'nodes')).toContain(avatar);
	expect(at('author')).toContain('__typename');
	expect(at('comments', 'nodes', 'author')).toContain('__typename');
	expect(at('reviews', 'nodes', 'author')).toContain('__typename');
	expect(at('latestOpinionatedReviews', 'nodes', 'author')).toContain('__typename');
	expect(at('reviewThreads', 'nodes', 'comments', 'nodes', 'author')).toContain('__typename');
});

// ---- the batch builder ----

test('the batch builder output matches its goldens', () => {
	for (const g of GOLDENS) {
		const built = buildDetailBatch(g.input);
		expect([g.name, built.query]).toEqual([g.name, g.query]);
		expect(built.query).toBe(g.query);
		expect(built.variables).toEqual(g.variables);
		// The golden is not empty, so that an empty text cannot pass.
		expect(tokens(g.query).length).toBeGreaterThan(200);
	}
});

test('the batch builder refuses an empty or oversized batch', () => {
	expect(BATCH_MAX).toBe(10);
	const pr = (number: number) => ({ number, head: 'feature', base: 'trunk' });
	const batch = (count: number) => ({ owner: 'example-org', name: 'app', prs: Array.from({ length: count }, (_, i) => pr(i + 1)) });
	expect(() => buildDetailBatch(batch(0))).toThrow();
	expect(() => buildDetailBatch(batch(BATCH_MAX + 1))).toThrow();
	expect(() => buildDetailBatch(batch(1))).not.toThrow();
	const full = buildDetailBatch(batch(BATCH_MAX));
	expect(full.query).toContain('pr9: pullRequest(number:$n9)');
	expect(full.query).not.toContain('pr10');
	expect(() => buildDetailBatch({ owner: 'example-org', name: 'app', prs: [pr(0)] })).toThrow();
	expect(() => buildDetailBatch({ owner: 'example-org', name: 'app', prs: [pr(1.5)] })).toThrow();
});

test('the batch builder puts names and branches only in variables', () => {
	const plain = buildDetailBatch({ owner: 'example-org', name: 'app', prs: [{ number: 7, head: 'feature/x', base: 'feature/y' }] });
	const hostile = { owner: 'Ünï-org', name: 'app$1', prs: [{ number: 7, head: '") { x }', base: 'rélease/$1' }] };
	const built = buildDetailBatch(hostile);
	// Only the count, the presence of a head and the kind of base decide the text.
	expect(built.query).toBe(plain.query);
	expect(built.variables).toEqual({ owner: 'Ünï-org', name: 'app$1', n0: 7, h0: '") { x }', b0: 'rélease/$1' });
	for (const text of ['") { x }', 'Ünï-org', 'app$1', 'rélease']) expect(built.query).not.toContain(text);
	// A different count gives a different text, and so does a PR with no head.
	expect(buildDetailBatch({ ...hostile, prs: [...hostile.prs, ...hostile.prs] }).query).not.toBe(built.query);
	expect(buildDetailBatch({ ...hostile, prs: [{ ...hostile.prs[0]!, head: '' }] }).query).not.toBe(built.query);
});

test('the batch builder adds each alias only when it is needed', () => {
	const build = (head: string, base: string) => buildDetailBatch({ owner: 'example-org', name: 'app', prs: [{ number: 1, head, base }] });
	const count = (text: string, part: string) => text.split(part).length - 1;
	const upOf = (base: string) => build('feature', base);
	// The default branches have no parent lookup; the match is exact and case-sensitive.
	for (const base of DEFAULT_BRANCHES) {
		expect(upOf(base).query).not.toContain('up0:');
		expect(upOf(base).variables).not.toHaveProperty('b0');
	}
	expect([...DEFAULT_BRANCHES].sort()).toEqual(['develop', 'main', 'master', 'trunk']);
	for (const base of ['Main', 'TRUNK', 'release/1.2', 'trunk ']) {
		expect(upOf(base).query).toContain('up0: pullRequests(headRefName:$b0');
		expect(upOf(base).query).toContain('$b0:String!');
		expect(upOf(base).variables).toHaveProperty('b0', base);
	}
	// A PR with no base has no parent lookup either.
	expect(upOf('').query).not.toContain('up0:');
	// The stacked-on-this lookup needs a head.
	expect(build('feature', 'trunk').query).toContain('dn0: pullRequests(baseRefName:$h0');
	expect(build('', 'trunk').query).not.toContain('dn0:');
	expect(build('', 'trunk').query).not.toContain('$h0');
	expect(build('', 'trunk').variables).toEqual({ owner: 'example-org', name: 'app', n0: 1 });
	// The MiniPr fragment is there once when an alias uses it, and never otherwise (an unused fragment is a GraphQL error).
	for (const [head, base] of [['feature', 'trunk'], ['feature', 'release/1.2'], ['', 'release/1.2']] as const) {
		const q = build(head, base).query;
		expect([head, base, count(q, 'fragment MiniPr on PullRequest')]).toEqual([head, base, 1]);
		expect([head, base, count(q, '...MiniPr')]).toEqual([head, base, (head ? 1 : 0) + (base === 'release/1.2' ? 1 : 0)]);
	}
	const none = build('', 'trunk').query;
	expect(count(none, 'MiniPr')).toBe(0);
	expect(count(none, 'fragment DetailPr on PullRequest')).toBe(1);
	// In a batch, each PR gets its own aliases, by its own index.
	const mixed = buildDetailBatch(THREE_PRS_MIXED_BASES.input).query;
	for (const alias of ['pr0:', 'dn0:', 'pr1:', 'dn1:', 'up1:', 'pr2:', 'dn2:']) expect(mixed).toContain(alias);
	for (const alias of ['up0:', 'up2:', 'pr3:']) expect(mixed).not.toContain(alias);
});

// ---- queries.json ----

test('queries.json has format 2 and the query templates', () => {
	const json = queriesJson();
	expect(json).toEqual({
		format: 2,
		apiVersion: API_VERSION,
		fields: { detailPr: DETAIL_PR_FIELDS, miniPr: MINI_PR_FIELDS, lightPr: LIGHT_PR_FIELDS, mergedPr: MERGED_PR_FIELDS },
		queries: { search: SEARCH_QUERY, merged: MERGED_SEARCH_QUERY, batch: BATCH_TEMPLATE, examples: expect.any(Array) },
	});
	expect(Object.keys(json).sort()).toEqual(['apiVersion', 'fields', 'format', 'queries']);
	expect(Object.keys(json.queries).sort()).toEqual(['batch', 'examples', 'merged', 'search']);
	expect(Object.keys(json.queries.batch).sort()).toEqual(['defaultBranches', 'fragments', 'max', 'perPr', 'query']);
	expect(json.queries.batch.max).toBe(BATCH_MAX);
	expect(json.queries.batch.defaultBranches).toEqual([...DEFAULT_BRANCHES]);
	// It survives being written as JSON.
	expect(JSON.parse(JSON.stringify(json))).toEqual(json);
});

test('queries.json examples match the batch goldens', () => {
	const { examples } = queriesJson().queries;
	expect(examples).toHaveLength(GOLDENS.length);
	expect(examples.length).toBeGreaterThanOrEqual(3);
	examples.forEach((e, i) => {
		const g = GOLDENS[i]!;
		expect(e.name).toBe(g.name);
		expect(e.input).toEqual(g.input);
		expect(e.query).toBe(g.query);
		expect(e.variables).toEqual(g.variables);
	});
	// One PR with dn and no up, one with dn and up, and a batch of three with a mixed base.
	expect(examples.map((e) => [e.input.prs.length, e.query.includes('up0:'), e.query.includes('dn0:')])).toEqual([
		[1, false, true],
		[1, true, true],
		[3, false, true],
	]);
	expect(examples[2]!.query).toContain('up1:');
	for (const e of examples) expect([e.input.owner, e.input.name]).toEqual(['example-org', 'app']);
});

test('each batch template placeholder appears exactly once', () => {
	const { batch, search, merged } = queriesJson().queries;
	const count = (text: string, part: string) => text.split(part).length - 1;
	for (const placeholder of ['<vars>', '<aliases>', '<fragments>']) expect([placeholder, count(batch.query, placeholder)]).toEqual([placeholder, 1]);
	// `<i>` is in every name, decl and alias, and in no other part.
	for (const e of batch.perPr) for (const part of [e.name, e.decl, e.alias]) expect([part, count(part, '<i>') > 0]).toEqual([part, true]);
	const others = [batch.query, ...batch.fragments.map((f) => f.text), search, merged, ...Object.values(queriesJson().fields)];
	for (const text of others) expect([text.slice(0, 40), text.includes('<i>')]).toEqual([text.slice(0, 40), false]);
	expect(JSON.stringify(batch)).not.toContain('{i}');
	// No placeholder is left after an expansion.
	for (const e of queriesJson().queries.examples) {
		expect([e.name, /<[A-Za-z]+>/.test(e.query)]).toEqual([e.name, false]);
		expect([e.name, /\{[A-Za-z]+\}/.test(e.query)]).toEqual([e.name, false]);
	}
	// The checks that a host makes when it loads the file (docs/embedding.md, rule 8).
	for (const e of batch.perPr) {
		expect(['always', 'head', 'parentBase']).toContain(e.when);
		expect(['number', 'head', 'base']).toContain(e.value);
	}
	for (const f of batch.fragments) expect(['always', 'stacks']).toContain(f.when);
	for (const set of Object.values(queriesJson().fields)) expect(set.includes('<')).toBe(false);
	expect(Number.isInteger(batch.max) && batch.max >= 1).toBe(true);
	expect(batch.defaultBranches.every((b) => typeof b === 'string')).toBe(true);
});

interface Template {
	max: number;
	defaultBranches: string[];
	query: string;
	perPr: { when: string; name: string; value: string; decl: string; alias: string }[];
	fragments: { when: string; text: string }[];
}

/**
 * Expands a template for an input with the rules in docs/embedding.md ("The joining rules"), and with no code of the builder.
 * Each comment quotes the sentence of the rule that the lines follow.
 */
function expand(t: Template, input: { owner: string; name: string; prs: { number: number; head: string; base: string }[] }) {
	// Rule 1: "The PRs keep their input order. `i` is the 0-based index, written in decimal."
	let declarations = '';
	let aliases = '';
	let stacks = false;
	// Rule 6: "`variables` holds `owner` and `name`, then the entries of step 3."
	const variables: Record<string, string | number> = { owner: input.owner, name: input.name };
	input.prs.forEach((pr, i) => {
		// Rule 2: "For each PR `i`, then for each `perPr` entry in array order, check whether its `when` holds".
		for (const entry of t.perPr) {
			const holds =
				entry.when === 'always' ||
				// "`head`: `head !== ""`."
				(entry.when === 'head' && pr.head !== '') ||
				// "`parentBase`: `base !== ""`, and `base` is not in `defaultBranches`. The match is exact and case-sensitive."
				(entry.when === 'parentBase' && pr.base !== '' && !t.defaultBranches.includes(pr.base));
			if (!holds) continue;
			// Rule 3: "replace every `<i>` in `name`, `decl` and `alias` with `i`."
			const withIndex = (text: string) => text.split('<i>').join(String(i));
			// "Append `decl` to V and `alias` to A" (V and A "start empty, and the join adds no separator of its own").
			declarations += withIndex(entry.decl);
			aliases += withIndex(entry.alias);
			// "set `variables[name]` to the input field `value`. `number` is a JSON integer."
			variables[withIndex(entry.name)] = ({ number: pr.number, head: pr.head, base: pr.base } as Record<string, string | number>)[entry.value]!;
			if (entry.when !== 'always') stacks = true;
		}
	});
	// Rule 4: "F is the concatenation, in array order, of the `text` of the `fragments` whose `when` holds."
	// "`always`: always true." "`stacks`: at least one PR had a `head` or `parentBase` entry that held."
	const fragments = t.fragments
		.filter((f) => f.when === 'always' || (f.when === 'stacks' && stacks))
		.map((f) => f.text)
		.join('');
	// Rule 5: "The substitution is literal and single-pass, and the inserted text is not scanned again."
	const values: Record<string, string> = { '<vars>': declarations, '<aliases>': aliases, '<fragments>': fragments };
	const query = t.query
		.split(/(<vars>|<aliases>|<fragments>)/)
		.map((piece) => values[piece] ?? piece)
		.join('');
	return { query, variables };
}

test('an independent expansion of the template reproduces every example', () => {
	// Only the parsed file is read: the template and the examples, as a host reads them.
	const { batch, examples } = JSON.parse(JSON.stringify(queriesJson())).queries as { batch: Template; examples: (ReturnType<typeof expand> & { input: Parameters<typeof expand>[1] })[] };
	expect(examples.length).toBeGreaterThanOrEqual(3);
	for (const e of examples) {
		const out = expand(batch, e.input);
		expect(out.query).toBe(e.query);
		expect(out.variables).toEqual(e.variables);
		for (const [key, value] of Object.entries(out.variables)) if (/^n\d+$/.test(key)) expect([key, typeof value]).toEqual([key, 'number']);
	}
	// The expansion is not the same text for every input.
	expect(new Set(examples.map((e) => expand(batch, e.input).query)).size).toBe(examples.length);
});
