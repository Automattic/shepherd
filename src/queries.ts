// The GraphQL that the server sends to GitHub. A host that ports the data layer reads the field sets and the
// query templates from dist/queries.json (`bun run build:client`), so it asks for the same fields.
//
// Each field set is a bare selection body: no outer braces, no variables and no aliases.
// A host uses one as the body of a PullRequest selection of its own.
//
// The detail query is built from BATCH_TEMPLATE, and from nothing else. `buildDetailBatch()` joins the parts of the
// template, and `queriesJson()` exports the same object. The joining rules are in docs/embedding.md.

import { API_VERSION } from './types.ts';

/** The selection of a pull request in the detail query. */
export const DETAIL_PR_FIELDS = `
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
	comments(last:50) { nodes { author { __typename login } createdAt } }
	reviews(last:50) { nodes { author { __typename login } submittedAt } }
	commits(last:50) { nodes { commit { committedDate author { user { login } } } } }
	reviewThreads(first:100) { nodes {
		isResolved isOutdated path line
		comments(first:1) { nodes { author { __typename login } body url createdAt } }
	} }`;

/** The selection of the stacked-PR nodes (the PR a PR is stacked on, and the PRs stacked on it) in the detail query. */
export const MINI_PR_FIELDS = 'number title url author { login }';

/** The selection of a pull request in the open list search. */
export const LIGHT_PR_FIELDS = `
	number title url isDraft updatedAt createdAt headRefName baseRefName isCrossRepository headRepositoryOwner { login }
	author { login ... on User { name } }
	repository { name owner { login } }`;

/** The selection of a pull request in the merged search. */
export const MERGED_PR_FIELDS =
	'number title url mergedAt author { login } mergedBy { login } latestOpinionatedReviews(first:30) { nodes { state submittedAt author { __typename login } } } repository { name owner { login } }';

const searchQuery = (fields: string) => `query($q:String!, $after:String) {
	rateLimit { remaining limit resetAt cost }
	search(query:$q, type:ISSUE, first:100, after:$after) {
		issueCount pageInfo { hasNextPage endCursor }
		nodes { ... on PullRequest { ${fields} } }
	}
}`;

export const SEARCH_QUERY = searchQuery(LIGHT_PR_FIELDS);
export const MERGED_SEARCH_QUERY = searchQuery(MERGED_PR_FIELDS);

/** The most PRs of one repository in one detail query. */
export const BATCH_MAX = 10;

/**
 * The parts of the batch detail query. `buildDetailBatch()` joins them; a host joins them with the same rules
 * (docs/embedding.md). In `query`, `<vars>`, `<aliases>` and `<fragments>` each appear once. In `name`, `decl` and
 * `alias`, `<i>` is the 0-based index of the PR in the batch. `when` and `value` take the values of the types below.
 */
export const BATCH_TEMPLATE: BatchTemplate = {
	max: BATCH_MAX,
	defaultBranches: ['trunk', 'main', 'master', 'develop'],
	query:
		'query($owner:String!, $name:String!<vars>) {\n\trateLimit { remaining limit resetAt cost }\n\trepository(owner:$owner, name:$name) {\n\t\tdefaultBranchRef { name target { oid } }<aliases>\n\t}\n}\n<fragments>',
	perPr: [
		{ when: 'always', name: 'n<i>', value: 'number', decl: ', $n<i>:Int!', alias: '\n\t\tpr<i>: pullRequest(number:$n<i>) { ...DetailPr }' },
		{
			when: 'head',
			name: 'h<i>',
			value: 'head',
			decl: ', $h<i>:String!',
			alias: '\n\t\tdn<i>: pullRequests(baseRefName:$h<i>, first:10, states:[OPEN]) { nodes { ...MiniPr } }',
		},
		{
			when: 'parentBase',
			name: 'b<i>',
			value: 'base',
			decl: ', $b<i>:String!',
			alias: '\n\t\tup<i>: pullRequests(headRefName:$b<i>, first:1, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}) { nodes { ...MiniPr } }',
		},
	],
	fragments: [
		{ when: 'always', text: `fragment DetailPr on PullRequest {${DETAIL_PR_FIELDS}}\n` },
		{ when: 'stacks', text: `fragment MiniPr on PullRequest { ${MINI_PR_FIELDS} }\n` },
	],
};

export interface BatchTemplate {
	max: number;
	defaultBranches: string[];
	query: string;
	perPr: { when: 'always' | 'head' | 'parentBase'; name: string; value: 'number' | 'head' | 'base'; decl: string; alias: string }[];
	fragments: { when: 'always' | 'stacks'; text: string }[];
}

/** Branches that a stacked PR's parent lookup skips: a PR into one of them has no parent PR. */
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(BATCH_TEMPLATE.defaultBranches);

export interface BatchInput {
	owner: string;
	name: string;
	/** 1 to BATCH_MAX PRs of the repository. `head` and `base` are branch names. */
	prs: { number: number; head: string; base: string }[];
}

export interface BatchQuery {
	query: string;
	variables: Record<string, string | number>;
}

const atIndex = (text: string, i: number): string => text.split('<i>').join(String(i));

/**
 * Builds the detail query for 1 to BATCH_MAX PRs of one repository by joining the parts of BATCH_TEMPLATE.
 * The text depends only on how many PRs there are, on whether each has a head branch, and on whether each base is
 * a default branch. Names and branches reach GitHub only as variables.
 */
export function buildDetailBatch({ owner, name, prs }: BatchInput): BatchQuery {
	const t = BATCH_TEMPLATE;
	if (prs.length < 1 || prs.length > t.max) throw new Error(`A detail batch has 1 to ${t.max} PRs, not ${prs.length}`);
	const variables: BatchQuery['variables'] = { owner, name };
	let vars = '';
	let aliases = '';
	let stacks = false;
	prs.forEach((pr, i) => {
		if (!Number.isInteger(pr.number) || pr.number < 1) throw new Error(`A detail batch needs a PR number that is a positive integer, not ${pr.number}`);
		const holds = { always: true, head: pr.head !== '', parentBase: pr.base !== '' && !t.defaultBranches.includes(pr.base) };
		for (const e of t.perPr) {
			if (!holds[e.when]) continue;
			vars += atIndex(e.decl, i);
			aliases += atIndex(e.alias, i);
			variables[atIndex(e.name, i)] = { number: pr.number, head: pr.head, base: pr.base }[e.value];
			if (e.when !== 'always') stacks = true;
		}
	});
	const fragments = t.fragments
		.filter((f) => f.when === 'always' || stacks)
		.map((f) => f.text)
		.join('');
	const parts: Record<string, string> = { vars, aliases, fragments };
	return { query: t.query.replace(/<(vars|aliases|fragments)>/g, (_, key: string) => parts[key]!), variables };
}

// The inputs of the examples in dist/queries.json: no stack lookup beyond the PRs stacked on this one, a PR
// stacked on another PR, and a batch of three that mixes default and other bases.
const EXAMPLES: { name: string; input: BatchInput }[] = [
	{ name: 'one-pr-default-base', input: { owner: 'example-org', name: 'app', prs: [{ number: 101, head: 'feature/login', base: 'trunk' }] } },
	{ name: 'one-pr-stacked', input: { owner: 'example-org', name: 'app', prs: [{ number: 110, head: 'feature/stacked-ui', base: 'feature/base-work' }] } },
	{
		name: 'three-prs-mixed-bases',
		input: {
			owner: 'example-org',
			name: 'app',
			prs: [
				{ number: 201, head: 'feature/a', base: 'trunk' },
				{ number: 202, head: 'feature/b', base: 'feature/a' },
				{ number: 203, head: 'fix/c', base: 'main' },
			],
		},
	},
];

/** The content of dist/queries.json: the field sets and the query templates that a host ports. */
export function queriesJson(): {
	format: number;
	apiVersion: number;
	fields: { detailPr: string; miniPr: string; lightPr: string; mergedPr: string };
	queries: {
		search: string;
		merged: string;
		batch: BatchTemplate;
		examples: ({ name: string; input: BatchInput } & BatchQuery)[];
	};
} {
	return {
		format: 2,
		apiVersion: API_VERSION,
		fields: { detailPr: DETAIL_PR_FIELDS, miniPr: MINI_PR_FIELDS, lightPr: LIGHT_PR_FIELDS, mergedPr: MERGED_PR_FIELDS },
		queries: {
			search: SEARCH_QUERY,
			merged: MERGED_SEARCH_QUERY,
			batch: BATCH_TEMPLATE,
			examples: EXAMPLES.map((e) => ({ ...e, ...buildDetailBatch(e.input) })),
		},
	};
}
