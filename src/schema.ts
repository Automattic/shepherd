// A small validator for the JSON Schema subset that src/settings-schema.ts uses.
// Shepherd has no runtime dependencies, so it does not load a JSON Schema library. A host in another
// language validates the same schema file (dist/settings.schema.json) with its own code. docs/embedding.md
// lists the keywords that such a validator must support. Do not use a keyword here that is not in that list.

/** A JSON Schema node, with the Shepherd keywords that start with `x-`. */
export interface SchemaNode {
	$ref?: string;
	type?: SchemaType | SchemaType[];
	enum?: readonly unknown[];
	minLength?: number;
	pattern?: string;
	minimum?: number;
	exclusiveMinimum?: number;
	minItems?: number;
	minProperties?: number;
	required?: readonly string[];
	properties?: Record<string, SchemaNode>;
	additionalProperties?: boolean | SchemaNode;
	propertyNames?: SchemaNode;
	items?: SchemaNode;
	definitions?: Record<string, SchemaNode>;
	/** The value must be a key of the object at this JSON pointer in the document. */
	'x-keyOf'?: string;
	/** The value must equal a value at this JSON pointer in the document. `*` matches every item or key. */
	'x-memberOf'?: string;
	/** The items of the array must have different values in this property. */
	'x-uniqueBy'?: string;
	/** A name for an item of an array in messages, such as "{owner}/{name}". */
	'x-label'?: string;
	/** The message of a failed check: one for each keyword, or one for all of them. */
	'x-message'?: string | Partial<Record<Keyword | 'default', string>>;
	[key: string]: unknown;
}

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

type Keyword =
	| 'type' | 'enum' | 'minLength' | 'pattern' | 'minimum' | 'exclusiveMinimum' | 'minItems' | 'minProperties'
	| 'required' | 'additionalProperties' | 'propertyNames' | 'x-keyOf' | 'x-memberOf' | 'x-uniqueBy';

/** One failed check. */
export interface SchemaError {
	/** A JSON pointer (RFC 6901) to the value, for example `/personal/repos/2/owner`. */
	pointer: string;
	keyword: Keyword;
	message: string;
}

export interface ValidateOptions {
	/**
	 * Changes the path segments before a message shows them. The first segment of a pointer is
	 * left out of messages (`/personal/team/0` shows as `team[0]`), so a rewrite sees the rest.
	 */
	rewritePath?: (segments: string[]) => string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Escapes a pointer segment (RFC 6901). */
const escapeSegment = (s: string): string => s.replaceAll('~', '~0').replaceAll('/', '~1');
const unescapeSegment = (s: string): string => s.replaceAll('~1', '/').replaceAll('~0', '~');

export const toPointer = (segments: readonly (string | number)[]): string => segments.map((s) => `/${escapeSegment(String(s))}`).join('');
export const fromPointer = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map(unescapeSegment));

/** The values at a pointer whose segments can be `*`, for any item of an array or any value of an object. */
export function valuesAt(doc: unknown, pointer: string): unknown[] {
	let current: unknown[] = [doc];
	for (const seg of fromPointer(pointer)) {
		const next: unknown[] = [];
		for (const v of current) {
			if (seg === '*') {
				if (Array.isArray(v)) next.push(...v);
				else if (isObject(v)) next.push(...Object.values(v));
			} else if (Array.isArray(v) && /^\d+$/.test(seg)) {
				if (Number(seg) < v.length) next.push(v[Number(seg)]);
			} else if (isObject(v) && Object.hasOwn(v, seg)) {
				next.push(v[seg]);
			}
		}
		current = next;
	}
	return current;
}

function typeOf(v: unknown): SchemaType {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
	return typeof v as SchemaType;
}

function hasType(v: unknown, type: SchemaType): boolean {
	if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
	if (type === 'integer') return typeof v === 'number' && Number.isInteger(v);
	if (type === 'object') return isObject(v);
	return typeOf(v) === type;
}

const quoteList = (values: readonly unknown[]): string => values.map((v) => JSON.stringify(v)).join(', ');

interface Frame {
	/** The path from the document root. */
	segments: string[];
	/** The schema of each array item on the path, at the same index as its segment, for `x-label`. */
	itemSchemas: (SchemaNode | undefined)[];
	/** The value of each segment, at the same index, for `x-label`. */
	values: unknown[];
}

export function validate(root: SchemaNode, doc: unknown, options: ValidateOptions = {}): SchemaError[] {
	const errors: SchemaError[] = [];

	const resolve = (node: SchemaNode): SchemaNode => {
		let n = node;
		for (let hops = 0; n.$ref && hops < 20; hops++) {
			const target = n.$ref.startsWith('#') ? valuesAt(root, n.$ref.slice(1))[0] : undefined;
			if (!isObject(target)) throw new Error(`Schema $ref not found: ${n.$ref}`);
			n = target as SchemaNode;
		}
		return n;
	};

	/** Renders the path of a frame, minus its first segment, as `team[0] (alice).logins`. */
	const render = (frame: Frame, upTo: number): string => {
		const all = frame.segments.slice(0, upTo);
		const labels = all.map((_, i) => {
			const schema = frame.itemSchemas[i];
			return schema?.['x-label'] ? label(schema['x-label'], frame.values[i]) : '';
		});
		let segs = all.slice(1);
		let segLabels = labels.slice(1);
		if (options.rewritePath) {
			const rewritten = options.rewritePath(segs);
			// A rewrite moves segments, so labels stay only when the segments did not change.
			if (rewritten.join('/') !== segs.join('/')) segLabels = [];
			segs = rewritten;
		}
		let out = '';
		segs.forEach((seg, i) => {
			out += /^\d+$/.test(seg) ? `[${seg}]` : out ? `.${seg}` : seg;
			if (segLabels[i]) out += ` (${segLabels[i]})`;
		});
		return out;
	};

	const report = (node: SchemaNode, keyword: Keyword, frame: Frame, extra: Record<string, string> = {}): void => {
		const custom = node['x-message'];
		const template = typeof custom === 'string' ? custom : (custom?.[keyword] ?? custom?.default ?? GENERIC[keyword]);
		const n = frame.segments.length;
		// The nearest array item on the path, or the parent when there is none.
		let itemAt = -1;
		for (let i = n - 1; i >= 0 && itemAt < 0; i--) if (frame.itemSchemas[i]) itemAt = i;
		// A message can name the allowed values also when an earlier check (the type) failed.
		const memberOf = node['x-memberOf'] !== undefined ? valuesAt(doc, node['x-memberOf']).map(String).join(', ') : undefined;
		const vars: Record<string, string> = {
			...(memberOf !== undefined ? { options: memberOf } : {}),
			path: render(frame, n),
			parent: render(frame, n - 1),
			item: render(frame, itemAt >= 0 ? itemAt + 1 : n - 1),
			key: frame.segments[n - 1] ?? '',
			value: String(frame.values[n - 1]),
			...extra,
		};
		errors.push({ pointer: toPointer(frame.segments), keyword, message: template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m) });
	};

	const child = (frame: Frame, seg: string, value: unknown, itemSchema?: SchemaNode): Frame => ({
		segments: [...frame.segments, seg],
		itemSchemas: [...frame.itemSchemas, itemSchema],
		values: [...frame.values, value],
	});

	const walk = (raw: SchemaNode, value: unknown, frame: Frame): void => {
		const node = resolve(raw);
		if (node.type !== undefined) {
			const types = Array.isArray(node.type) ? node.type : [node.type];
			if (!types.some((t) => hasType(value, t))) return report(node, 'type', frame, { type: types.join(' or ') });
		}
		if (node.enum && !node.enum.some((e) => e === value)) return report(node, 'enum', frame, { enum: quoteList(node.enum) });
		if (typeof value === 'string') {
			if (node.minLength !== undefined && value.length < node.minLength) report(node, 'minLength', frame);
			if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(value)) report(node, 'pattern', frame);
		}
		if (typeof value === 'number') {
			if (node.minimum !== undefined && !(value >= node.minimum)) report(node, 'minimum', frame);
			if (node.exclusiveMinimum !== undefined && !(value > node.exclusiveMinimum)) report(node, 'exclusiveMinimum', frame);
		}
		if (node['x-keyOf'] !== undefined && typeof value === 'string') {
			const target = valuesAt(doc, node['x-keyOf'])[0];
			if (isObject(target) && !Object.hasOwn(target, value)) report(node, 'x-keyOf', frame, { options: Object.keys(target).join(', ') });
		}
		if (node['x-memberOf'] !== undefined) {
			const options = valuesAt(doc, node['x-memberOf']);
			if (!options.some((o) => o === value)) report(node, 'x-memberOf', frame, { options: options.map(String).join(', ') });
		}
		if (Array.isArray(value)) {
			if (node.minItems !== undefined && value.length < node.minItems) report(node, 'minItems', frame);
			if (node.items) value.forEach((item, i) => walk(node.items!, item, child(frame, String(i), item, resolve(node.items!))));
			const by = node['x-uniqueBy'];
			if (by !== undefined) {
				const seen = new Set<unknown>();
				value.forEach((item, i) => {
					const v = isObject(item) ? item[by] : undefined;
					if (v === undefined) return;
					if (seen.has(v)) report(node, 'x-uniqueBy', child(child(frame, String(i), item, resolve(node.items ?? {})), by, v));
					seen.add(v);
				});
			}
		}
		if (isObject(value)) {
			const keys = Object.keys(value);
			if (node.minProperties !== undefined && keys.length < node.minProperties) report(node, 'minProperties', frame);
			for (const name of node.required ?? []) {
				// A missing property reports the message of its own schema, so each one can say what it needs.
				if (!Object.hasOwn(value, name)) report(resolve(node.properties?.[name] ?? {}), 'required', child(frame, name, undefined));
			}
			for (const key of keys) {
				const sub = child(frame, key, value[key]);
				if (node.propertyNames) {
					const names = resolve(node.propertyNames);
					const before = errors.length;
					walk(names, key, sub);
					// A property name check reports at the property, with its name as the value.
					for (const e of errors.slice(before)) if (e.keyword === 'x-keyOf' || e.keyword === 'enum' || e.keyword === 'pattern') e.keyword = 'propertyNames';
					if (errors.length > before) continue;
				}
				const prop = node.properties?.[key];
				if (prop) walk(prop, value[key], sub);
				else if (node.additionalProperties === false) report(node, 'additionalProperties', sub);
				else if (isObject(node.additionalProperties)) walk(node.additionalProperties, value[key], sub);
			}
		}
	};

	walk(root, doc, { segments: [], itemSchemas: [], values: [] });
	return errors;
}

/** Fills `{field}` placeholders of an `x-label` from an item. Gives '' when a field is not a non-empty string. */
function label(template: string, item: unknown): string {
	if (!isObject(item)) return '';
	let missing = false;
	const out = template.replace(/\{(\w+)\}/g, (_, k: string) => {
		const v = item[k];
		if (typeof v !== 'string' || !v) missing = true;
		return String(v);
	});
	return missing ? '' : out;
}

/** Messages for a check whose schema has no `x-message`. */
const GENERIC: Record<Keyword, string> = {
	type: '{path} must be {type}',
	enum: '{path} must be one of {enum}',
	minLength: '{path} must not be empty',
	pattern: '{path} is not in the expected format',
	minimum: '{path} is too small',
	exclusiveMinimum: '{path} is too small',
	minItems: '{path} must not be empty',
	minProperties: '{path} must not be empty',
	required: '{parent} needs {key}',
	additionalProperties: '{path} is not a setting',
	propertyNames: '{path} is not an allowed name',
	'x-keyOf': '{path} must be one of {options}',
	'x-memberOf': '{path} must be one of {options}',
	'x-uniqueBy': '{path} "{value}" is used twice',
};
