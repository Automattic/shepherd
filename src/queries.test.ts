import { expect, test } from 'bun:test';
import {
	DETAIL_PR_FIELDS,
	DETAIL_QUERY,
	LIGHT_PR_FIELDS,
	MERGED_PR_FIELDS,
	MERGED_SEARCH_QUERY,
	MINI_PR_FIELDS,
	SEARCH_QUERY,
	queriesJson,
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

const BASE_DETAIL_QUERY = `query($owner:String!, $name:String!, $n:Int!, $head:String!, $base:String!, $withParent:Boolean!) {
	rateLimit { remaining limit resetAt cost }
	repository(owner:$owner, name:$name) {
		defaultBranchRef { name target { oid } }
		pullRequest(number:$n) {
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
			} }
		}
		parent: pullRequests(headRefName:$base, first:1, states:[OPEN], orderBy:{field:UPDATED_AT, direction:DESC}) @include(if:$withParent) {
			nodes { number title url author { login } }
		}
		stackedOnThis: pullRequests(baseRefName:$head, first:10, states:[OPEN]) {
			nodes { number title url author { login } }
		}
	}
}`;

/** The tokens of a GraphQL text. Whitespace and commas do not count. */
const tokens = (text: string): string[] => text.match(/\$?[A-Za-z_]\w*|\.\.\.|[{}()\[\]:!@=]|\d+/g) ?? [];

test('the built queries match the queries at 2f42e0b', () => {
	expect(tokens(SEARCH_QUERY)).toEqual(tokens(BASE_SEARCH_QUERY));
	expect(tokens(MERGED_SEARCH_QUERY)).toEqual(tokens(BASE_MERGED_SEARCH_QUERY));
	expect(tokens(DETAIL_QUERY)).toEqual(tokens(BASE_DETAIL_QUERY));
	// The golden is not empty, so that an empty tokenizer result cannot pass.
	expect(tokens(BASE_DETAIL_QUERY).length).toBeGreaterThan(200);
});

test('each built query contains its exported field set', () => {
	expect(DETAIL_QUERY).toContain(DETAIL_PR_FIELDS);
	expect(DETAIL_QUERY.split(MINI_PR_FIELDS)).toHaveLength(3); // the parent and the stackedOnThis nodes
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

test('queries.json content is the exported field sets', () => {
	expect(queriesJson()).toEqual({
		apiVersion: API_VERSION,
		fields: { detailPr: DETAIL_PR_FIELDS, miniPr: MINI_PR_FIELDS, lightPr: LIGHT_PR_FIELDS, mergedPr: MERGED_PR_FIELDS },
	});
});
