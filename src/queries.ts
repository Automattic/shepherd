// The GraphQL that the server sends to GitHub. A host that ports the data layer reads the field sets
// from dist/queries.json (`bun run build:client`), so it asks for the same fields.
//
// Each field set is a bare selection body: no outer braces, no variables and no aliases.
// A host wraps one in `fragment X on PullRequest { ... }` or in `... on PullRequest { ... }`.

import { API_VERSION } from './types.ts';

/** Branches that a stacked PR's parent lookup skips: a PR into one of them has no parent PR. */
export const DEFAULT_BRANCHES = new Set(['trunk', 'main', 'master', 'develop']);

/** The selection of `pullRequest(number:$n)` in the detail query. */
export const DETAIL_PR_FIELDS = `
	number title url state merged mergedAt isDraft updatedAt createdAt
	headRefName baseRefName isCrossRepository headRepositoryOwner { login } headRefOid baseRefOid baseRef { target { oid } } body mergeable reviewDecision additions deletions changedFiles
	author { login ... on User { name } }
	statusCheckRollup { state }
	reviewRequests(first:30) { nodes { requestedReviewer {
		__typename
		... on User { login name }
		... on Team { slug combinedSlug name }
	} } }
	latestOpinionatedReviews(first:30) { nodes { state submittedAt author { login } } }
	participants(first:50) { totalCount nodes { login name } }
	comments(last:50) { nodes { author { login } createdAt } }
	reviews(last:50) { nodes { author { login } submittedAt } }
	commits(last:50) { nodes { commit { committedDate author { user { login } } } } }
	reviewThreads(first:100) { nodes {
		isResolved isOutdated path line
		comments(first:1) { nodes { author { login } body url createdAt } }
	} }`;

/** The selection of the `parent` and `stackedOnThis` nodes in the detail query. */
export const MINI_PR_FIELDS = 'number title url author { login }';

/** The selection of a pull request in the open list search. */
export const LIGHT_PR_FIELDS = `
	number title url isDraft updatedAt createdAt headRefName baseRefName isCrossRepository headRepositoryOwner { login }
	author { login ... on User { name } }
	repository { name owner { login } }`;

/** The selection of a pull request in the merged search. */
export const MERGED_PR_FIELDS = 'number title url mergedAt author { login } repository { name owner { login } }';

const searchQuery = (fields: string) => `query($q:String!, $after:String) {
	rateLimit { remaining limit resetAt cost }
	search(query:$q, type:ISSUE, first:100, after:$after) {
		issueCount pageInfo { hasNextPage endCursor }
		nodes { ... on PullRequest { ${fields} } }
	}
}`;

export const SEARCH_QUERY = searchQuery(LIGHT_PR_FIELDS);
export const MERGED_SEARCH_QUERY = searchQuery(MERGED_PR_FIELDS);

export const DETAIL_QUERY = `query($owner:String!, $name:String!, $n:Int!, $head:String!, $base:String!, $withParent:Boolean!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		defaultBranchRef { name target { oid } }
		pullRequest(number:$n) { ${DETAIL_PR_FIELDS} }
		parent: pullRequests(headRefName:$base, first:1, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}) @include(if:$withParent) {
			nodes { ${MINI_PR_FIELDS} }
		}
		stackedOnThis: pullRequests(baseRefName:$head, first:10, states:[OPEN]) {
			nodes { ${MINI_PR_FIELDS} }
		}
	}
}`;

/** The content of dist/queries.json: the field sets that a host ports. */
export function queriesJson(): {
	apiVersion: number;
	fields: { detailPr: string; miniPr: string; lightPr: string; mergedPr: string };
} {
	return {
		apiVersion: API_VERSION,
		fields: { detailPr: DETAIL_PR_FIELDS, miniPr: MINI_PR_FIELDS, lightPr: LIGHT_PR_FIELDS, mergedPr: MERGED_PR_FIELDS },
	};
}
