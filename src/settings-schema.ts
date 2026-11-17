// The one rulebook for settings. `problems()` in config.ts checks config.json with it, the local
// server checks each PUT /api/settings with it, and `bun run build:client` writes it to
// dist/settings.schema.json for a host that keeps settings in its own storage.
// It describes a `SettingsDocument`: { personal, deployment }. src/schema.ts validates it.

import { FEATURES } from './features.ts';
import { PUSH_POLICIES } from './push-policy.ts';
import { MIN_ROW_REFRESH_MS } from './row-refresh.ts';
import type { SchemaNode } from './schema.ts';

const POLICY_LIST = PUSH_POLICIES.map((p) => `"${p}"`).join(', ');
const FEATURE_LIST = `${FEATURES.slice(0, -1).join(', ')} or ${FEATURES.at(-1)}`;
const MS = `must be a number of milliseconds (${MIN_ROW_REFRESH_MS} or more), or no such field`;

const pushPolicy = (message: string): SchemaNode => ({ enum: [...PUSH_POLICIES], 'x-message': message });
const positiveInteger = (message: string): SchemaNode => ({ type: 'integer', minimum: 1, 'x-message': message });

/** A GitHub login, or a GitHub App's login with the `[bot]` suffix. Also used for a team id that keys a per-author policy. */
const LOGIN = '^[A-Za-z0-9][A-Za-z0-9_.-]*(\\[bot\\])?$';
/** A GitHub org or user name. */
const OWNER = '^[A-Za-z0-9][A-Za-z0-9-]*$';
/** A GitHub repo name. */
const REPO_NAME = '^[A-Za-z0-9._-]+$';
/** A host name, without a port (gh refuses one). It never starts with `-`, so `gh` cannot read it as a flag. */
const HOSTNAME = '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$';
/**
 * A key of `hosts`. It is part of JSON pointers and of each login and repo, so only plain characters. It starts with a
 * letter or digit (never `__proto__`) and is not the name of an Object.prototype member, so a lookup by key never finds one.
 */
const HOST_KEY = '^(?!(constructor|toString|toLocaleString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable)$)[A-Za-z0-9][A-Za-z0-9_-]*$';
/** A team id. It is part of attributes, JSON pointers and per-author policy keys, so only plain characters. */
const MEMBER_ID = '^[A-Za-z0-9][A-Za-z0-9_.-]*$';
/** The workspace slug in Linear URLs, such as acme. */
const LINEAR_WORKSPACE = '^[A-Za-z0-9][A-Za-z0-9_-]*$';
/** A Linear team key, such as ENG. The client and the server build a regular expression from these. */
const LINEAR_KEY = '^[A-Za-z][A-Za-z0-9]*$';

const member: SchemaNode = {
	type: 'object',
	'x-label': '{id}',
	'x-message': '{path} must be an object',
	required: ['id', 'name', 'short', 'logins'],
	additionalProperties: false,
	properties: {
		id: { type: 'string', minLength: 1, pattern: MEMBER_ID, 'x-message': { default: '{item} needs id, name and short', pattern: '{item} needs an id of letters, digits, ., _ and -, such as "sam"' } },
		name: { type: 'string', minLength: 1, 'x-message': '{item} needs id, name and short' },
		short: { type: 'string', minLength: 1, 'x-message': '{item} needs id, name and short' },
		logins: {
			type: 'object',
			minProperties: 1,
			'x-message': '{item} needs "logins": { "<host key>": "<login>" }',
			propertyNames: { 'x-keyOf': '/deployment/hosts', 'x-message': '{item} has a login for unknown host "{key}"' },
			additionalProperties: {
				type: 'string',
				minLength: 1,
				pattern: LOGIN,
				'x-message': { default: '{item} needs a login for host "{key}"', pattern: '{item} needs a GitHub login for host "{key}": letters, digits and -, with no spaces' },
			},
		},
		pushPolicy: pushPolicy(`{item} needs "pushPolicy" to be one of ${POLICY_LIST}, or no such field`),
	},
};

const repo: SchemaNode = {
	type: 'object',
	'x-label': '{owner}/{name}',
	'x-message': '{path} must be an object',
	required: ['host', 'owner', 'name', 'short'],
	additionalProperties: false,
	properties: {
		host: { type: 'string', 'x-keyOf': '/deployment/hosts', 'x-message': '{item} uses unknown host "{value}"' },
		// The owner and the name go into GitHub search terms, so only the characters that GitHub allows in them.
		owner: { type: 'string', minLength: 1, pattern: OWNER, 'x-message': { default: '{item} needs owner, name and short', pattern: '{item} needs an owner of letters, digits and -, such as example-org' } },
		name: { type: 'string', minLength: 1, pattern: REPO_NAME, 'x-message': { default: '{item} needs owner, name and short', pattern: '{item} needs a repo name of letters, digits, ., _ and -' } },
		short: { type: 'string', minLength: 1, 'x-message': '{item} needs owner, name and short' },
		maxBaseAgeHours: { type: 'number', exclusiveMinimum: 0, 'x-message': '{item} needs "maxBaseAgeHours" to be a positive number, or no such field' },
		allAuthors: { type: 'boolean', 'x-message': '{item} needs "allAuthors" to be true or false, or no such field' },
		pushPolicy: pushPolicy(`{item} needs "pushPolicy" to be one of ${POLICY_LIST}, or no such field`),
		pushPolicyByAuthor: {
			type: 'object',
			'x-message': '{item} needs "pushPolicyByAuthor" to be an object of team id or login to policy, or no such field',
			propertyNames: { pattern: LOGIN, 'x-message': '{item} pushPolicyByAuthor needs a team id or login for each policy, not "{key}"' },
			additionalProperties: pushPolicy(`{item} pushPolicyByAuthor."{key}" must be one of ${POLICY_LIST}`),
		},
	},
};

const host: SchemaNode = {
	type: 'object',
	'x-message': '{path} must be an object',
	required: ['hostname'],
	properties: {
		hostname: { type: 'string', pattern: HOSTNAME, 'x-message': '{parent} needs a hostname, such as github.com' },
		label: { type: 'string', 'x-message': '{path} must be a string' },
		bot: { type: ['string', 'null'], pattern: LOGIN, 'x-message': '{path} must be a login or null' },
		botsByOwner: {
			type: 'object',
			'x-message': '{path} must be an object of owner (an org or a user) to bot login or null, or no such field',
			propertyNames: { pattern: OWNER, 'x-message': '{parent} has "{key}", which is not an org or user name' },
			additionalProperties: { type: ['string', 'null'], pattern: LOGIN, 'x-message': '{path} must be a bot login, or null for none' },
		},
		concurrency: positiveInteger('{path} must be a whole number, 1 or more, or no such field'),
		proxied: { type: 'boolean', 'x-message': '{path} must be true or false, or no such field' },
		rowRefreshFloorMs: { type: 'number', minimum: MIN_ROW_REFRESH_MS, 'x-message': `{path} ${MS}` },
		rowRefreshLowBudgetMs: { type: 'number', minimum: MIN_ROW_REFRESH_MS, 'x-message': `{path} ${MS}` },
		defaultOrgs: {
			type: 'array',
			items: { type: 'string', pattern: OWNER, 'x-message': '{parent} must be a list of org or user names, such as example-org' },
			'x-message': '{path} must be a list of org or user names, or no such field',
		},
	},
};

export const SETTINGS_SCHEMA_ID = 'https://shepherd.invalid/settings.schema.json';

export const SETTINGS_SCHEMA: SchemaNode = {
	$schema: 'http://json-schema.org/draft-07/schema#',
	$id: SETTINGS_SCHEMA_ID,
	title: 'Shepherd settings',
	description:
		'A SettingsDocument from src/types.ts. Keywords that start with x- are Shepherd rules; docs/embedding.md says how to check them. ' +
		'x-message is the message of a failed check, with {path}, {parent}, {item}, {key}, {value}, {enum} and {options} filled in.',
	type: 'object',
	required: ['personal', 'deployment'],
	properties: {
		personal: { $ref: '#/definitions/personal' },
		deployment: { $ref: '#/definitions/deployment' },
	},
	definitions: {
		personal: {
			type: 'object',
			'x-message': '{path} must be an object',
			required: ['me', 'team', 'repos'],
			additionalProperties: false,
			properties: {
				me: { type: 'string', 'x-memberOf': '/personal/team/*/id', 'x-message': '`me` must be one of the team ids ({options})' },
				team: {
					type: 'array',
					minItems: 1,
					items: { $ref: '#/definitions/member' },
					'x-uniqueBy': 'id',
					'x-message': { default: '`team` must be a non-empty array', 'x-uniqueBy': 'team id "{value}" is used twice' },
				},
				repos: { type: 'array', items: { $ref: '#/definitions/repo' }, 'x-message': '`repos` must be an array' },
				reviewTeams: {
					type: 'object',
					'x-message': '`reviewTeams` must be an object of host key to "org/team" names',
					propertyNames: { 'x-keyOf': '/deployment/hosts', 'x-message': '{path} is for unknown host "{key}"' },
					additionalProperties: {
						type: 'array',
						items: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$', 'x-message': '{parent} must be a list of "org/team" names, or no such field' },
						'x-message': '{path} must be a list of "org/team" names, or no such field',
					},
				},
				anyRepo: {
					type: 'object',
					'x-message': '`anyRepo` must be an object of host key to { "orgs": [ … ] }, or no such field',
					propertyNames: { 'x-keyOf': '/deployment/hosts', 'x-message': '{path} is for unknown host "{key}"' },
					additionalProperties: {
						type: 'object',
						required: ['orgs'],
						additionalProperties: false,
						'x-message': '{path} must be { "orgs": [ … ] }',
						properties: {
							orgs: {
								type: 'array',
								minItems: 1,
								items: { type: 'string', pattern: OWNER, 'x-message': '{parent} must be a list of org or user names, such as example-org' },
								'x-message': {
									default: '{path} must be a list of org or user names',
									minItems: '{path} needs at least one org: any repo means any repo in these orgs',
									required: '{path} needs at least one org: any repo means any repo in these orgs',
								},
							},
						},
					},
				},
				linear: {
					type: ['object', 'null'],
					required: ['workspace', 'keys'],
					additionalProperties: false,
					'x-message': '`linear` needs `workspace` and `keys` (or remove it)',
					properties: {
						workspace: {
							type: 'string',
							pattern: LINEAR_WORKSPACE,
							'x-message': { default: '`linear` needs `workspace` and `keys` (or remove it)', pattern: '`linear.workspace` must be the slug in your Linear URLs: letters, digits, - and _' },
						},
						keys: {
							type: 'array',
							items: { type: 'string', pattern: LINEAR_KEY, 'x-message': '`linear.keys` must be team keys such as ENG: a letter, then letters or digits' },
							'x-message': '`linear` needs `workspace` and `keys` (or remove it)',
						},
					},
				},
				features: {
					type: 'object',
					'x-message': '`features` must be an object (or remove it)',
					propertyNames: { enum: [...FEATURES], 'x-message': `\`{path}\` is not a feature (use ${FEATURE_LIST})` },
					additionalProperties: { type: 'boolean', 'x-message': '`{path}` must be true or false' },
				},
			},
		},
		deployment: {
			type: 'object',
			'x-message': '{path} must be an object',
			required: ['hosts'],
			properties: {
				hosts: {
					type: 'object',
					propertyNames: { pattern: HOST_KEY, 'x-message': 'host key "{key}" must start with a letter or digit, have only letters, digits, - and _, and not be a JavaScript name such as constructor' },
					additionalProperties: { $ref: '#/definitions/host' },
					'x-message': '`hosts` must be an object',
				},
				refresh: { enum: ['rows', 'list'], 'x-message': '`refresh` must be "rows" or "list", or no such field' },
				aiReviewLabel: { type: 'string', 'x-message': '`aiReviewLabel` must be a string, or no such field' },
				ignoreParticipants: { type: 'array', items: { type: 'string' }, 'x-message': '`ignoreParticipants` must be a list of logins, or no such field' },
				limits: {
					type: 'object',
					'x-message': '`limits` must be an object, or no such field',
					additionalProperties: false,
					properties: {
						maxPeople: positiveInteger('`limits.maxPeople` must be a whole number, 1 or more'),
						maxRepos: positiveInteger('`limits.maxRepos` must be a whole number, 1 or more'),
						maxBells: positiveInteger('`limits.maxBells` must be a whole number, 1 or more'),
						maxOrgs: positiveInteger('`limits.maxOrgs` must be a whole number, 1 or more'),
						requestBudget: {
							type: 'object',
							required: ['requests', 'perSeconds'],
							'x-message': '`limits.requestBudget` needs `requests` and `perSeconds`, whole numbers of 1 or more',
							properties: {
								requests: positiveInteger('`limits.requestBudget` needs `requests` and `perSeconds`, whole numbers of 1 or more'),
								perSeconds: positiveInteger('`limits.requestBudget` needs `requests` and `perSeconds`, whole numbers of 1 or more'),
							},
						},
					},
				},
			},
		},
		member,
		repo,
		host,
	},
};

/** The text of dist/settings.schema.json. */
export const settingsSchemaJson = (): string => `${JSON.stringify(SETTINGS_SCHEMA, null, '\t')}\n`;
