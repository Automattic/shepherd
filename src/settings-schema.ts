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

const member: SchemaNode = {
	type: 'object',
	'x-label': '{id}',
	'x-message': '{path} must be an object',
	required: ['id', 'name', 'short', 'logins'],
	properties: {
		id: { type: 'string', minLength: 1, 'x-message': '{item} needs id, name and short' },
		name: { type: 'string', minLength: 1, 'x-message': '{item} needs id, name and short' },
		short: { type: 'string', minLength: 1, 'x-message': '{item} needs id, name and short' },
		logins: {
			type: 'object',
			minProperties: 1,
			'x-message': '{item} needs "logins": { "<host key>": "<login>" }',
			propertyNames: { 'x-keyOf': '/deployment/hosts', 'x-message': '{item} has a login for unknown host "{key}"' },
			additionalProperties: { type: 'string', minLength: 1, 'x-message': '{item} needs a login for host "{key}"' },
		},
		pushPolicy: pushPolicy(`{item} needs "pushPolicy" to be one of ${POLICY_LIST}, or no such field`),
	},
};

const repo: SchemaNode = {
	type: 'object',
	'x-label': '{owner}/{name}',
	'x-message': '{path} must be an object',
	required: ['host', 'owner', 'name', 'short'],
	properties: {
		host: { type: 'string', 'x-keyOf': '/deployment/hosts', 'x-message': '{item} uses unknown host "{value}"' },
		owner: { type: 'string', minLength: 1, 'x-message': '{item} needs owner, name and short' },
		name: { type: 'string', minLength: 1, 'x-message': '{item} needs owner, name and short' },
		short: { type: 'string', minLength: 1, 'x-message': '{item} needs owner, name and short' },
		maxBaseAgeHours: { type: 'number', exclusiveMinimum: 0, 'x-message': '{item} needs "maxBaseAgeHours" to be a positive number, or no such field' },
		allAuthors: { type: 'boolean', 'x-message': '{item} needs "allAuthors" to be true or false, or no such field' },
		pushPolicy: pushPolicy(`{item} needs "pushPolicy" to be one of ${POLICY_LIST}, or no such field`),
		pushPolicyByAuthor: {
			type: 'object',
			'x-message': '{item} needs "pushPolicyByAuthor" to be an object of team id or login to policy, or no such field',
			additionalProperties: pushPolicy(`{item} pushPolicyByAuthor."{key}" must be one of ${POLICY_LIST}`),
		},
	},
};

const host: SchemaNode = {
	type: 'object',
	'x-message': '{path} must be an object',
	required: ['hostname'],
	properties: {
		hostname: { type: 'string', minLength: 1, 'x-message': '{parent} needs a hostname' },
		label: { type: 'string', 'x-message': '{path} must be a string' },
		bot: { type: ['string', 'null'], 'x-message': '{path} must be a login or null' },
		concurrency: positiveInteger('{path} must be a whole number, 1 or more, or no such field'),
		rowRefreshFloorMs: { type: 'number', minimum: MIN_ROW_REFRESH_MS, 'x-message': `{path} ${MS}` },
		rowRefreshLowBudgetMs: { type: 'number', minimum: MIN_ROW_REFRESH_MS, 'x-message': `{path} ${MS}` },
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
				linear: {
					type: ['object', 'null'],
					required: ['workspace', 'keys'],
					'x-message': '`linear` needs `workspace` and `keys` (or remove it)',
					properties: {
						workspace: { type: 'string', minLength: 1, 'x-message': '`linear` needs `workspace` and `keys` (or remove it)' },
						keys: { type: 'array', items: { type: 'string', minLength: 1 }, 'x-message': '`linear` needs `workspace` and `keys` (or remove it)' },
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
				hosts: { type: 'object', additionalProperties: { $ref: '#/definitions/host' }, 'x-message': '`hosts` must be an object' },
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
