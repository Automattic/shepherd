// The settings panel: edits the personal settings through GET and PUT /api/settings, and the GitHub hosts where the
// server allows it. It shows the other deployment settings and the cost limits read-only. It runs on the standalone page and on a
// host page, because every call goes through the client's `api()` (apiBase, headers, trailing slash).
// The per-browser UI state (bells, filters, sort, refresh interval, theme) stays in localStorage; see web/app.ts.
//
// Layout: a rail of sections on the left, and one section on the right. People and repos are rows that open,
// one at a time, into their fields. A section with refused fields shows their count in the rail.

import { FEATURES, type Feature } from '../src/features.ts';
import { PUSH_POLICIES, PUSH_POLICY_LABELS } from '../src/push-policy.ts';
import { fromPointer, toPointer } from '../src/schema.ts';
import { fieldMeta } from '../src/settings.ts';
import { exportSettings, importSettings } from '../src/settings-transfer.ts';
import type { DeploymentSettings, PersonalSettings, PushPolicy, SettingsErrorResponse, SettingsFieldError, SettingsResponse, TeamMember } from '../src/types.ts';

export interface SettingsPanelDeps {
	/** The mount element. The panel renders into a <dialog> inside it, so the dashboard styles apply. */
	root: HTMLElement;
	api: (path: string, init?: RequestInit) => Promise<Response>;
	/** Called after a save. The page loads again with the new settings. */
	onSaved: () => void;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for HTML. Never throws: a value that cannot be turned into text (such as `{ "toString": 1 }`) shows as its type. */
const esc = (s: unknown): string => {
	let text: string;
	try {
		text = String(s ?? '');
	} catch {
		text = Object.prototype.toString.call(s);
	}
	return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const FEATURE_TEXT: Record<Feature, [label: string, hint: string]> = {
	shipped: ['Shipped section', 'The PRs the team merged this week, last week or in the last 30 days.'],
	followups: ['Follow-ups', 'Non-blocking asks left on merged PRs. They show only in the Shipped section.'],
	herdr: ['herdr terminal panes', 'A chip on each row for the terminal panes working on that PR.'],
};

type Section = 'you' | 'people' | 'repos' | 'review' | 'linear' | 'features' | 'server';

const SECTIONS: [key: Section, label: string, icon: string, blurb: string][] = [
	['you', 'You', 'fa-user', 'Whose dashboard this is.'],
	['people', 'People', 'fa-users', 'The team whose PRs and review requests the dashboard follows.'],
	['repos', 'Repos', 'fa-code-branch', 'Where to look for PRs, and the push policy of each repo.'],
	['review', 'Review teams', 'fa-user-group', 'GitHub teams the people above review for. A request to one of these teams counts as a request to them.'],
	['linear', 'Linear', 'fa-ticket', 'Turn ticket keys in titles, branches and descriptions into links.'],
	['features', 'Features', 'fa-toggle-on', 'Parts of the dashboard that you can turn off.'],
	['server', 'Server', 'fa-server', 'The GitHub hosts and their AI-review bots, and the settings of whoever runs this Shepherd.'],
];

/** The section that shows the field at `pointer`. A pointer that no section has goes to "You". */
function sectionOf(pointer: string): Section {
	if (pointer.startsWith('/deployment')) return 'server';
	const seg = fromPointer(pointer)[1];
	const map: Record<string, Section> = { me: 'you', team: 'people', repos: 'repos', reviewTeams: 'review', linear: 'linear', features: 'features' };
	return (seg && map[seg]) || 'you';
}

function isSettingsResponse(v: unknown): v is SettingsResponse {
	return isRecord(v) && typeof v.version === 'string' && isRecord(v.personal) && isRecord(v.deployment) && isRecord(v.fields);
}

/** Sets the value at a pointer under `doc`. `undefined` removes the key. */
function setAt(doc: Record<string, unknown>, pointer: string, value: unknown): void {
	const segs = fromPointer(pointer);
	let target: unknown = doc;
	for (const seg of segs.slice(0, -1)) {
		if (!isRecord(target) && !Array.isArray(target)) return;
		const t = target as Record<string, unknown>;
		if (t[seg] === undefined || t[seg] === null) t[seg] = {};
		target = t[seg];
	}
	const last = segs.at(-1)!;
	const t = target as Record<string, unknown>;
	if (value === undefined) delete t[last];
	else t[last] = value;
}

const list = (text: string): string[] =>
	text
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

const initials = (name: string): string =>
	name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]!.toUpperCase())
		.join('') || '?';

/** A stable hue per id, for the avatar circles. */
const hue = (id: string): number => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

const avatar = (m: Pick<TeamMember, 'id' | 'name'>, size = ''): string =>
	`<span class="s-avatar${size}" style="--h:${hue(m.id || m.name || '?')}" aria-hidden="true">${esc(initials(m.name || m.id))}</span>`;

const pill = (p: PushPolicy | undefined, unset: string): string => {
	// The value comes from the server; only a known policy becomes a class name.
	const known = p !== undefined && (PUSH_POLICIES as readonly string[]).includes(p) ? p : undefined;
	return `<span class="s-pill ${known ? `s-tone-${known}` : 's-tone-unset'}">${esc(known ? PUSH_POLICY_LABELS[known] : unset)}</span>`;
};

export function createSettingsPanel({ root, api, onSaved }: SettingsPanelDeps): { open(): Promise<void> } {
	const dialog = document.createElement('dialog');
	dialog.className = 'settings';
	dialog.setAttribute('aria-labelledby', 'settings-title');
	root.append(dialog);

	let loaded: SettingsResponse | null = null;
	/** The working copy that the form edits: `{ personal }`, so pointers match the API's. */
	let draft: { personal: PersonalSettings; deployment: DeploymentSettings } | null = null;
	let errors: SettingsFieldError[] = [];
	let notice: { kind: 'error' | 'ok'; html: string } | null = null;
	let busy = false;
	/** What the panel shows, apart from the settings: the section, and the person or repo that is open. */
	let view: { section: Section; person?: number; repo?: number } = { section: 'you' };
	/** The errors that the last render has already moved the view to. */
	let shownErrors: SettingsFieldError[] = [];
	/** The pointers whose errors the current render placed at a field. */
	let placed = new Set<string>();

	const meta = (pointer: string) => fieldMeta(loaded!.fields, pointer);
	const disabled = (pointer: string): string => {
		const m = meta(pointer);
		return m.editable ? '' : ` disabled title="${esc(m.reason || 'Not editable')}"`;
	};
	const viewer = (): TeamMember | undefined => draft!.personal.team.find((m) => m.id === draft!.personal.me);
	// The hosts of the draft, so a host added in this edit shows up in the logins, repos and review teams at once.
	const hostKeys = (): string[] => Object.keys(draft!.deployment.hosts);
	const hostLabel = (key: string): string => draft!.deployment.hosts[key]?.label || key;
	const dirty = (): boolean =>
		!!loaded && !!draft && (JSON.stringify(draft.personal) !== JSON.stringify(loaded.personal) || JSON.stringify(draft.deployment.hosts) !== JSON.stringify(loaded.deployment.hosts));
	const errorsUnder = (pointer: string): number => errors.filter((e) => e.path === pointer || e.path.startsWith(`${pointer}/`)).length;

	/** The errors for exactly this field. render() lists the errors that no field showed at the top of the section. */
	function fieldErrors(pointer: string): string {
		const mine = errors.filter((e) => e.path === pointer);
		if (mine.length) placed.add(pointer);
		return mine.map((e) => `<p class="s-err" role="alert"><i class="fa-solid fa-circle-exclamation"></i>${esc(e.message)}</p>`).join('');
	}

	// -------------------------------------------------------------------------
	// Controls. Each one has data-path (a JSON pointer into the draft) and data-kind (how to read its value).

	const field = (label: string, control: string, errs: string, hint = ''): string =>
		`<label class="s-field"><span class="s-label">${esc(label)}</span>${control}${hint ? `<span class="s-hint">${esc(hint)}</span>` : ''}${errs}</label>`;

	const input = (pointer: string, value: unknown, o: { kind?: 'string' | 'list' | 'number' | 'nullable'; placeholder?: string; attrs?: string; label?: string } = {}): string => {
		const number = o.kind === 'number';
		return `<input type="${number ? 'number' : 'text'}"${number ? ' min="1" step="1"' : ''} class="s-input" data-path="${esc(pointer)}" data-kind="${o.kind ?? 'string'}" value="${esc(value)}"${o.placeholder ? ` placeholder="${esc(o.placeholder)}"` : ''}${o.label ? ` aria-label="${esc(o.label)}"` : ''}${disabled(pointer)}${o.attrs ?? ''}>`;
	};

	const policySelect = (pointer: string, value: PushPolicy | undefined, none: string): string =>
		`<select class="s-select" data-path="${esc(pointer)}" data-kind="optional"${disabled(pointer)}>
			<option value="">${esc(none)}</option>
			${PUSH_POLICIES.map((p) => `<option value="${p}" ${value === p ? 'selected' : ''}>${esc(PUSH_POLICY_LABELS[p])}</option>`).join('')}
		</select>`;

	/** A checkbox drawn as a switch. kind "flag": true or no field. kind "feature": no field (on) or false. */
	const toggle = (pointer: string, on: boolean, kind: 'flag' | 'feature', label: string): string =>
		`<label class="s-switch"><input type="checkbox" role="switch" aria-label="${esc(label)}" data-path="${esc(pointer)}" data-kind="${kind}" ${on ? 'checked' : ''}${disabled(pointer)}><span class="s-track"></span></label>`;

	const toggleRow = (control: string, label: string, hint: string, errs = ''): string =>
		`<div class="s-toggle-row">${control}<div><strong>${esc(label)}</strong><span class="s-hint">${esc(hint)}</span></div>${errs}</div>`;

	// -------------------------------------------------------------------------
	// Sections

	function youSection(): string {
		const p = draft!.personal;
		const v = viewer();
		const i = v ? p.team.indexOf(v) : -1;
		const policy = toPointer(['personal', 'team', i, 'pushPolicy']);
		const who = meta('/personal/me');
		return `<div class="s-identity">
			${avatar(v ?? { id: p.me, name: p.me }, ' s-avatar-xl')}
			<div>
				<div class="s-identity-name">${esc(v?.name ?? p.me)}</div>
				<div class="s-identity-meta"><code>${esc(p.me)}</code>${Object.entries(v?.logins ?? {})
					.map(([h, l]) => ` · ${esc(hostLabel(h))} <code>${esc(l)}</code>`)
					.join('')}</div>
			</div>
		</div>
		${
			who.editable
				? field(
						'Who you are',
						`<select class="s-select" data-path="/personal/me" data-kind="string">${p.team.map((m) => `<option value="${esc(m.id)}" ${m.id === p.me ? 'selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</select>`,
						fieldErrors('/personal/me'),
						'Pick yourself from the people list.'
					)
				: `<p class="s-muted"><i class="fa-solid fa-lock"></i> ${esc(who.reason || 'Set by the host.')}</p>${fieldErrors('/personal/me')}`
		}
		${v ? field('Your push policy', policySelect(policy, v.pushPolicy, 'Not set'), fieldErrors(policy), 'What reviewers and their agents may do on your PRs. You can always push to your own.') : ''}`;
	}

	function personRow(m: TeamMember, i: number): string {
		const base = toPointer(['personal', 'team', i]);
		const open = view.person === i;
		const isViewer = m.id === draft!.personal.me;
		// Bells and per-author push policies follow the id, so only a person added in this edit gets a new one.
		const saved = loaded!.personal.team.some((x) => x.id === m.id);
		const count = errorsUnder(base);
		const head = `<button type="button" class="s-row-head" data-s-person="${i}" aria-expanded="${open}">
			${avatar(m)}
			<span class="s-row-title">${esc(m.name || 'New person')}${isViewer ? ' <span class="s-you">you</span>' : ''}</span>
			<span class="s-row-sub">${hostKeys()
				.map((h) => (Object.hasOwn(m.logins, h) && m.logins[h] ? `<span class="s-login"><b>${esc(hostLabel(h))}</b> ${esc(m.logins[h])}</span>` : ''))
				.join('')}</span>
			${count ? `<span class="s-errcount" title="${count} to fix">${count}</span>` : ''}
			${pill(m.pushPolicy, 'No policy')}
			<i class="fa-solid fa-chevron-down s-chev"></i>
		</button>`;
		if (!open) return `<div class="s-row" data-field="${base}">${head}</div>`;
		return `<div class="s-row open" data-field="${base}">${head}
			<div class="s-row-body">
				<div class="s-grid">
					${field('Name', input(`${base}/name`, m.name), fieldErrors(`${base}/name`))}
					${field('Label', input(`${base}/short`, m.short), fieldErrors(`${base}/short`), 'Shown on chips and filters.')}
					${field('Id', input(`${base}/id`, m.id, { attrs: isViewer || saved ? ' readonly' : '' }), fieldErrors(`${base}/id`), saved ? 'Fixed once saved: bells and policies follow it.' : 'Short and lowercase, for example "sam".')}
					${hostKeys()
						.map((h) => field(`${hostLabel(h)} login`, input(`${base}/logins/${h}`, Object.hasOwn(m.logins, h) ? m.logins[h] : ''), fieldErrors(`${base}/logins/${h}`)))
						.join('')}
					${field(isViewer ? 'Your push policy' : 'Push policy', policySelect(`${base}/pushPolicy`, m.pushPolicy, 'Not set'), fieldErrors(`${base}/pushPolicy`))}
				</div>
				${fieldErrors(base)}${fieldErrors(`${base}/logins`)}
				<div class="s-row-actions">
					${isViewer || !meta('/personal/team').editable ? '' : `<button type="button" class="s-danger" data-s-remove="${base}"><i class="fa-regular fa-trash-can"></i> Remove ${esc(m.name || 'person')}</button>`}
					<button type="button" class="s-link" data-s-person="${i}">Done</button>
				</div>
			</div>
		</div>`;
	}

	function repoRow(r: PersonalSettings['repos'][number], i: number): string {
		const base = toPointer(['personal', 'repos', i]);
		const open = view.repo === i;
		const byAuthor = r.pushPolicyByAuthor ?? {};
		const overrides = Object.keys(byAuthor).length;
		const count = errorsUnder(base);
		const head = `<button type="button" class="s-row-head" data-s-repo="${i}" aria-expanded="${open}">
			<span class="s-repo-icon"><i class="fa-solid fa-book-bookmark"></i></span>
			<span class="s-row-title"><code>${esc(r.owner && r.name ? `${r.owner}/${r.name}` : 'New repo')}</code></span>
			<span class="s-row-sub">
				<span class="s-login"><b>${esc(hostLabel(r.host))}</b></span>
				${r.allAuthors ? '<span class="s-tag">everyone</span>' : ''}
				${r.maxBaseAgeHours ? `<span class="s-tag">base &gt; ${esc(r.maxBaseAgeHours)}h</span>` : ''}
				${overrides ? `<span class="s-tag">${overrides} override${overrides > 1 ? 's' : ''}</span>` : ''}
			</span>
			${count ? `<span class="s-errcount" title="${count} to fix">${count}</span>` : ''}
			${pill(r.pushPolicy, 'No default')}
			<i class="fa-solid fa-chevron-down s-chev"></i>
		</button>`;
		if (!open) return `<div class="s-row" data-field="${base}">${head}</div>`;
		const editable = meta(`${base}/pushPolicyByAuthor`).editable;
		return `<div class="s-row open" data-field="${base}">${head}
			<div class="s-row-body">
				<div class="s-grid">
					${field(
						'Host',
						`<select class="s-select" data-path="${base}/host" data-kind="string"${disabled(`${base}/host`)}>${hostKeys()
							.map((h) => `<option value="${esc(h)}" ${r.host === h ? 'selected' : ''}>${esc(draft!.deployment.hosts[h]?.hostname || h)}</option>`)
							.join('')}</select>`,
						fieldErrors(`${base}/host`)
					)}
					${field('Owner', input(`${base}/owner`, r.owner), fieldErrors(`${base}/owner`))}
					${field('Name', input(`${base}/name`, r.name), fieldErrors(`${base}/name`))}
					${field('Label', input(`${base}/short`, r.short), fieldErrors(`${base}/short`))}
					${field('Flag a base older than', `<span class="s-suffix">${input(`${base}/maxBaseAgeHours`, r.maxBaseAgeHours ?? '', { kind: 'number' })}<span>hours</span></span>`, fieldErrors(`${base}/maxBaseAgeHours`))}
					${field('Default push policy', policySelect(`${base}/pushPolicy`, r.pushPolicy, 'No default'), fieldErrors(`${base}/pushPolicy`), 'Combined with the author’s policy, the stricter one wins.')}
				</div>
				${toggleRow(toggle(`${base}/allAuthors`, r.allAuthors === true, 'flag', 'List PRs by everyone'), 'List PRs by everyone', 'Not only the people on your team.', fieldErrors(`${base}/allAuthors`))}
				<div class="s-overrides" data-field="${base}/pushPolicyByAuthor">
					<div class="s-overrides-head"><strong>Per-author overrides</strong><span class="s-hint">They win over the person’s and the repo’s policy, in this repo only.</span></div>
					${Object.entries(byAuthor)
						.map(([key, p]) => {
							const ptr = toPointer(['personal', 'repos', i, 'pushPolicyByAuthor', key]);
							return `<div class="s-override" data-field="${esc(ptr)}">
								<input type="text" class="s-input" list="s-author-ids" aria-label="Team id or login" placeholder="Team id or login" value="${esc(key)}" data-s-author-key="${esc(key)}" data-repo="${i}"${editable ? '' : ' disabled'}>
								<i class="fa-solid fa-arrow-right s-muted" aria-hidden="true"></i>
								<select class="s-select" aria-label="Push policy for ${esc(key)}" data-path="${esc(ptr)}" data-kind="string"${editable ? '' : ' disabled'}>
									${PUSH_POLICIES.map((x) => `<option value="${x}" ${p === x ? 'selected' : ''}>${esc(PUSH_POLICY_LABELS[x])}</option>`).join('')}
								</select>
								${editable ? `<button type="button" class="s-icon" aria-label="Remove ${esc(key)}" data-s-author-remove="${esc(key)}" data-repo="${i}"><i class="fa-solid fa-xmark"></i></button>` : ''}
								${fieldErrors(ptr)}
							</div>`;
						})
						.join('')}
					${editable ? `<button type="button" class="s-link" data-s-author-add="${i}"><i class="fa-solid fa-plus"></i> Add an override</button>` : ''}
				</div>
				${fieldErrors(base)}${fieldErrors(`${base}/pushPolicyByAuthor`)}
				<div class="s-row-actions">
					${meta('/personal/repos').editable ? `<button type="button" class="s-danger" data-s-remove="${base}"><i class="fa-regular fa-trash-can"></i> Remove repo</button>` : ''}
					<button type="button" class="s-link" data-s-repo="${i}">Done</button>
				</div>
			</div>
		</div>`;
	}

	/** True when this server lets the viewer change the hosts, or at least their bots. */
	const hostsEditable = (): boolean =>
		meta('/deployment/hosts').editable ||
		hostKeys().some((k) => (['label', 'bot', 'botsByOwner'] as const).some((f) => meta(toPointer(['deployment', 'hosts', k, f])).editable));

	/** One host, as fields: the key (fixed once saved), the host name, the label, the default bot and the bots per owner. */
	function hostCard(k: string): string {
		const h = draft!.deployment.hosts[k]!;
		const base = toPointer(['deployment', 'hosts', k]);
		const saved = Object.hasOwn(loaded!.deployment.hosts, k);
		const listEditable = meta('/deployment/hosts').editable;
		const byOwner = h.botsByOwner ?? {};
		const ownersEditable = meta(`${base}/botsByOwner`).editable;
		const fileOnly = [
			h.concurrency !== undefined ? `up to ${esc(h.concurrency)} gh processes` : '',
			h.rowRefreshFloorMs ? `rows refresh at most every ${esc(Math.round(h.rowRefreshFloorMs / 1000))}s` : '',
			h.proxied ? 'goes through proxychains (removing the host, or giving it another key, removes that setting)' : '',
		].filter(Boolean);
		return `<div class="s-card s-host" data-field="${esc(base)}">
			<div class="s-grid">
				${field('Key', `<input type="text" class="s-input" value="${esc(k)}" aria-label="Host key" data-s-host-key="${esc(k)}"${saved || !listEditable ? ' readonly' : ''}>`, '', saved ? 'Logins, repos and review teams name the host by this key.' : 'Short, for example "ghe". Letters, digits, - and _.')}
				${field('Host name', input(`${base}/hostname`, h.hostname, { placeholder: 'github.com' }), fieldErrors(`${base}/hostname`))}
				${field('Label', input(`${base}/label`, h.label ?? '', { placeholder: 'GitHub' }), fieldErrors(`${base}/label`), 'Shown next to logins and repos.')}
				${field(`${loaded!.deployment.aiReviewLabel} bot`, input(`${base}/bot`, h.bot ?? '', { kind: 'nullable', placeholder: 'none' }), fieldErrors(`${base}/bot`), 'The default for every org on this host. Leave it empty for none.')}
			</div>
			<div class="s-overrides" data-field="${esc(base)}/botsByOwner">
				<div class="s-overrides-head"><strong>Bots per org</strong><span class="s-hint">An org (or user) whose repos have another ${esc(loaded!.deployment.aiReviewLabel)} bot, or none.</span></div>
				${Object.entries(byOwner)
					.map(([owner, bot]) => {
						const ptr = toPointer(['deployment', 'hosts', k, 'botsByOwner', owner]);
						return `<div class="s-override" data-field="${esc(ptr)}">
							<input type="text" class="s-input" aria-label="Org" placeholder="org" value="${esc(owner)}" data-s-org-key="${esc(owner)}" data-host="${esc(k)}"${ownersEditable ? '' : ' disabled'}>
							<i class="fa-solid fa-arrow-right s-muted" aria-hidden="true"></i>
							<input type="text" class="s-input" aria-label="Bot for ${esc(owner)}" placeholder="none" value="${esc(bot ?? '')}" data-path="${esc(ptr)}" data-kind="nullable"${ownersEditable ? '' : ' disabled'}>
							${ownersEditable ? `<button type="button" class="s-icon" aria-label="Remove ${esc(owner)}" data-s-org-remove="${esc(owner)}" data-host="${esc(k)}"><i class="fa-solid fa-xmark"></i></button>` : ''}
							${fieldErrors(ptr)}
						</div>`;
					})
					.join('')}
				${ownersEditable ? `<button type="button" class="s-link" data-s-org-add="${esc(k)}"><i class="fa-solid fa-plus"></i> Add an org</button>` : ''}
			</div>
			${fieldErrors(base)}${fieldErrors(`${base}/botsByOwner`)}
			${fileOnly.length ? `<p class="s-hint"><i class="fa-solid fa-lock"></i> In config.json: ${fileOnly.join(', ')}.</p>` : ''}
			${listEditable ? `<div class="s-row-actions"><button type="button" class="s-danger" data-s-host-remove="${esc(k)}"><i class="fa-regular fa-trash-can"></i> Remove host</button></div>` : ''}
		</div>`;
	}

	function serverSection(): string {
		const d = loaded!.deployment;
		const l = d.limits;
		const limit = (n: number | undefined) => (n !== undefined ? `up to ${esc(n)}` : 'no limit');
		const editable = hostsEditable();
		const listReason = meta('/deployment/hosts').reason;
		const hosts = editable
			? `${listReason ? `<p class="s-muted"><i class="fa-solid fa-lock"></i> ${esc(listReason)}</p>` : ''}
				${fieldErrors('/deployment/hosts')}
				<div class="s-hosts">${hostKeys().map(hostCard).join('')}</div>
				${meta('/deployment/hosts').editable ? '<button type="button" class="s-add" data-s-host-add><i class="fa-solid fa-plus"></i> Add a host</button>' : ''}`
			: `<div class="s-cards">${Object.entries(d.hosts)
					.map(
						([k, h]) => `<div class="s-card">
						<div class="s-card-title">${esc(h.label || k)} <code>${esc(k)}</code></div>
						<dl class="s-dl"><dt>Hostname</dt><dd>${esc(h.hostname)}</dd><dt>AI-review bot</dt><dd>${esc(h.bot ?? '—')}</dd>${Object.entries(h.botsByOwner ?? {})
							.map(([owner, bot]) => `<dt>Bot for ${esc(owner)}</dt><dd>${esc(bot ?? 'none')}</dd>`)
							.join('')}<dt>Row refresh floor</dt><dd>${h.rowRefreshFloorMs ? `${esc(Math.round(h.rowRefreshFloorMs / 1000))}s` : 'default'}</dd></dl>
					</div>`
					)
					.join('')}</div>`;
		const reason = meta('/deployment/limits').reason;
		return `<h3 class="s-subhead">GitHub hosts</h3>
		${hosts}
		<h3 class="s-subhead">This server</h3>
		${reason ? `<p class="s-muted"><i class="fa-solid fa-lock"></i> ${esc(reason)}</p>` : ''}
		<dl class="s-dl">
			<dt>Refresh mode</dt><dd><code>${esc(d.refresh)}</code></dd>
			<dt>AI-review label</dt><dd>${esc(d.aiReviewLabel)}</dd>
			<dt>People</dt><dd>${limit(l.maxPeople)}</dd>
			<dt>Repos</dt><dd>${limit(l.maxRepos)}</dd>
			<dt>Bells</dt><dd>${limit(l.maxBells)}</dd>
			<dt>Requests</dt><dd>${l.requestBudget ? `${esc(l.requestBudget.requests)} per ${esc(l.requestBudget.perSeconds)} seconds` : 'no limit'}</dd>
		</dl>`;
	}

	function section(key: Section): string {
		const p = draft!.personal;
		switch (key) {
			case 'you':
				return youSection();
			case 'people':
				return `${fieldErrors('/personal/team')}<div class="s-rows">${p.team.map(personRow).join('')}</div>
					${meta('/personal/team').editable ? '<button type="button" class="s-add" data-s-add="team"><i class="fa-solid fa-plus"></i> Add a person</button>' : ''}`;
			case 'repos':
				return `${fieldErrors('/personal/repos')}${p.repos.length ? `<div class="s-rows">${p.repos.map(repoRow).join('')}</div>` : '<p class="s-muted">No repos: PRs are found by author.</p>'}
					${meta('/personal/repos').editable ? '<button type="button" class="s-add" data-s-add="repos"><i class="fa-solid fa-plus"></i> Add a repo</button>' : ''}`;
			case 'review':
				return hostKeys()
					.map((h) => {
						const ptr = toPointer(['personal', 'reviewTeams', h]);
						// An error on one name of the list (…/reviewTeams/<host>/<i>) shows under the list.
						const items = errors.filter((e) => e.path.startsWith(`${ptr}/`));
						items.forEach((e) => placed.add(e.path));
						return field(
							hostLabel(h),
							input(ptr, (Object.hasOwn(p.reviewTeams, h) ? p.reviewTeams[h]! : []).join(', '), { kind: 'list', placeholder: 'org/team, org/other-team' }),
							fieldErrors(ptr) + items.map((e) => `<p class="s-err" role="alert"><i class="fa-solid fa-circle-exclamation"></i>${esc(e.message)}</p>`).join(''),
							'As org/team, separated by commas.'
						);
					})
					.join('');
			case 'linear':
				return `${toggleRow(`<label class="s-switch"><input type="checkbox" role="switch" aria-label="Link Linear tickets" data-s-linear ${p.linear ? 'checked' : ''}${disabled('/personal/linear')}><span class="s-track"></span></label>`, 'Link Linear tickets', 'Keys such as ABC-123 become links.')}
					${
						p.linear
							? `<div class="s-grid">${field('Workspace', input('/personal/linear/workspace', p.linear.workspace, { placeholder: 'acme' }), fieldErrors('/personal/linear/workspace'), 'The slug in your Linear URLs.')}${field('Team keys', input('/personal/linear/keys', p.linear.keys.join(', '), { kind: 'list', placeholder: 'ENG, OPS' }), fieldErrors('/personal/linear/keys'), 'Separated by commas.')}</div>`
							: ''
					}
					${fieldErrors('/personal/linear')}`;
			case 'features':
				return `<div class="s-toggles">${FEATURES.map((f) => {
					const ptr = `/personal/features/${f}`;
					const [label, hint] = FEATURE_TEXT[f];
					const m = meta(ptr);
					return toggleRow(toggle(ptr, p.features[f] !== false, 'feature', label), label, m.editable ? hint : (m.reason ?? hint), fieldErrors(ptr));
				}).join('')}</div>${fieldErrors('/personal/features')}`;
			default:
				return serverSection();
		}
	}

	function render(): void {
		if (!loaded || !draft) {
			dialog.innerHTML = `<div class="s-loading"><div class="s-head"><h2 id="settings-title">Settings</h2><button type="button" class="icon-btn" data-s-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
				<div class="s-body">${notice ? `<div class="s-notice ${notice.kind}">${notice.html}</div>` : '<p class="s-muted">Loading…</p>'}</div></div>`;
			return;
		}
		// After a refused save, open the section, and the person or repo, of the first error.
		if (errors.length && errors !== shownErrors) {
			const first = errors[0]!.path;
			view = { section: sectionOf(first) };
			const m = /^\/personal\/(team|repos)\/(\d+)/.exec(first);
			if (m) view[m[1] === 'team' ? 'person' : 'repo'] = Number(m[2]);
		}
		shownErrors = errors;
		placed = new Set();
		const p = draft.personal;
		const [, label, icon, blurb] = SECTIONS.find((s) => s[0] === view.section)!;
		const content = section(view.section);
		// Errors of this section that no field showed (for example, of a removed row) show at the top.
		const loose = errors.filter((e) => sectionOf(e.path) === view.section && !placed.has(e.path));
		const counts: Partial<Record<Section, string>> = { people: String(p.team.length), repos: String(p.repos.length), linear: p.linear ? 'on' : 'off' };
		const scroller = dialog.querySelector('.s-body');
		const top = scroller?.scrollTop ?? 0;
		const sameSection = dialog.dataset.section === view.section;
		dialog.innerHTML = `
			<form method="dialog" class="s-form" novalidate>
				<datalist id="s-author-ids">${p.team.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</datalist>
				<nav class="s-rail" aria-label="Settings sections">
					<div class="s-rail-title">Settings</div>
					${SECTIONS.map(([k, l, ic]) => {
						const n = errors.filter((e) => sectionOf(e.path) === k).length;
						const on = k === view.section;
						return `<button type="button" class="s-nav${on ? ' on' : ''}" data-s-section="${k}"${on ? ' aria-current="page"' : ''}>
							<i class="fa-solid ${ic}"></i><span>${esc(l)}</span>
							${n ? `<span class="s-errcount" title="${n} to fix">${n}</span>` : counts[k] ? `<span class="s-count">${esc(counts[k])}</span>` : k === 'server' && !hostsEditable() ? '<i class="fa-solid fa-lock s-lock" title="Read-only"></i>' : ''}
						</button>`;
					}).join('')}
					<p class="s-rail-foot">Bells, filters, sort and the refresh interval stay in this browser.</p>
				</nav>
				<div class="s-main">
					<header class="s-head">
						<div><h2 id="settings-title"><i class="fa-solid ${icon}"></i> ${esc(label)}</h2><p>${esc(blurb)}</p></div>
						<button type="button" class="icon-btn" data-s-close aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
					</header>
					<div class="s-body">
						${loaded.problems?.length ? `<div class="s-notice error"><strong>The server kept its last good settings.</strong><ul>${loaded.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
						${notice ? `<div class="s-notice ${notice.kind}">${notice.html}</div>` : ''}
						${loose.length ? `<div class="s-notice error"><ul>${loose.map((e) => `<li><code>${esc(e.path)}</code> ${esc(e.message)}</li>`).join('')}</ul></div>` : ''}
						${content}
					</div>
					<footer class="s-foot">
						<button type="button" class="chip-btn" data-s-export title="Download your saved settings as a file, to import here or on another Shepherd"><i class="fa-solid fa-download"></i> Export</button>
						<button type="button" class="chip-btn" data-s-import title="Load settings from an exported file. You review them, then save."><i class="fa-solid fa-upload"></i> Import</button>
						<span class="s-dirty" data-s-dirty${dirty() ? '' : ' hidden'}><i class="fa-solid fa-circle"></i> Unsaved changes</span>
						<span class="s-spacer"></span>
						<button type="button" class="chip-btn" data-s-close>Cancel</button>
						<button type="submit" class="chip-btn on" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save'}</button>
					</footer>
				</div>
			</form>`;
		// Keep the place in a section across renders (an add, a row that opens), but start a new section at the top.
		const body = dialog.querySelector('.s-body');
		if (body && sameSection) body.scrollTop = top;
		dialog.dataset.section = view.section;
	}

	/** Downloads the saved settings (not unsaved edits) as a settings file. */
	function exportFile(): void {
		if (!loaded) return;
		const blob = new Blob([`${JSON.stringify(exportSettings(loaded), null, 2)}\n`], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `shepherd-settings-${new Date().toISOString().slice(0, 10)}.json`;
		dialog.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	/** Reads a settings file into the panel. Nothing is saved until the viewer saves. */
	function pickImport(): void {
		const picker = document.createElement('input');
		picker.type = 'file';
		picker.accept = 'application/json,.json';
		picker.addEventListener('change', async () => {
			const f = picker.files?.[0];
			if (!f || !loaded || !draft) return;
			try {
				const result = importSettings(JSON.parse(await f.text()) as unknown, loaded);
				draft.personal = result.personal;
				if (result.hosts) draft.deployment.hosts = result.hosts;
				errors = [];
				view = { section: 'you' };
				const notes = result.notes.length ? `<ul>${result.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
				notice = { kind: 'ok', html: `<strong>Imported ${esc(f.name)}.</strong> Look over the settings, then save them.${notes}` };
			} catch (e) {
				notice = { kind: 'error', html: `<strong>Could not import ${esc(f.name)}.</strong> ${esc(e instanceof SyntaxError ? 'The file is not JSON.' : (e as Error).message)}` };
			}
			try {
				render();
			} catch (e) {
				// The import checks the file, so this is a bug: go back to the saved settings rather than leave a broken panel.
				console.error(e);
				show(loaded);
			}
		});
		picker.click();
	}

	/** Renders, then puts the focus back on the control that caused it, which the render replaced. */
	function renderFocus(selector: string): void {
		render();
		dialog.querySelector<HTMLElement>(selector)?.focus();
	}

	async function load(): Promise<void> {
		loaded = null;
		draft = null;
		errors = [];
		notice = null;
		view = { section: 'you' };
		render();
		try {
			const res = await api('/api/settings');
			const body: unknown = await res.json().catch(() => undefined);
			if (!res.ok || !isSettingsResponse(body)) {
				const why = isRecord(body) && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
				notice = { kind: 'error', html: `<strong>Could not load the settings.</strong> ${esc(why)}` };
				render();
				return;
			}
			show(body);
		} catch (e) {
			notice = { kind: 'error', html: `<strong>Could not load the settings.</strong> ${esc((e as Error).message)}` };
			render();
		}
	}

	function show(settings: SettingsResponse): void {
		loaded = settings;
		draft = { personal: structuredClone(settings.personal), deployment: structuredClone(settings.deployment) };
		render();
	}

	async function submit(): Promise<void> {
		if (!loaded || !draft || busy) return;
		busy = true;
		notice = null;
		render();
		try {
			const res = await api('/api/settings', {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				// The hosts go only to a server that lets the viewer change them; a host that locks them never gets them.
				body: JSON.stringify({ version: loaded.version, personal: draft.personal, ...(hostsEditable() ? { deployment: { hosts: draft.deployment.hosts } } : {}) }),
			});
			const body: unknown = await res.json().catch(() => undefined);
			busy = false;
			if (res.ok && isSettingsResponse(body)) {
				errors = [];
				notice = { kind: 'ok', html: 'Saved. Loading the dashboard with the new settings…' };
				render();
				onSaved();
				return;
			}
			const err = (isRecord(body) ? body : {}) as Partial<SettingsErrorResponse>;
			errors = Array.isArray(err.errors) ? err.errors : [];
			if (res.status === 409 && err.settings && isSettingsResponse(err.settings)) {
				const fresh = err.settings;
				notice = {
					kind: 'error',
					html: `<strong>${esc(err.error || 'The settings changed somewhere else.')}</strong> <button type="button" class="chip-btn" data-s-reload>Load the current settings</button> (your changes here are lost)`,
				};
				dialog.dataset.fresh = JSON.stringify(fresh);
			} else {
				notice = { kind: 'error', html: `<strong>${esc(err.error || `The server refused the settings (HTTP ${res.status}).`)}</strong>` };
			}
			render();
		} catch (e) {
			busy = false;
			notice = { kind: 'error', html: `<strong>Could not save.</strong> ${esc((e as Error).message)}` };
			render();
		}
	}

	dialog.addEventListener('input', (e) => {
		const el = e.target;
		if (!draft || !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) || !el.dataset.path) return;
		const kind = el.dataset.kind;
		const raw = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
		let value: unknown = raw;
		if (kind === 'list') value = list(String(raw));
		else if (kind === 'number') value = String(raw).trim() === '' ? undefined : Number(raw);
		else if (kind === 'optional') value = raw === '' ? undefined : raw;
		// A bot field left empty is no bot.
		else if (kind === 'nullable') value = String(raw).trim() === '' ? null : String(raw).trim();
		else if (kind === 'flag') value = raw === true ? true : undefined;
		// A feature that is on has no entry, as in config.json.
		else if (kind === 'feature') value = raw === true ? undefined : false;
		else if (kind === 'string') value = String(raw);
		// A login left empty is no login on that host.
		if (/\/logins\/[^/]+$/.test(el.dataset.path) && value === '') value = undefined;
		setAt(draft as unknown as Record<string, unknown>, el.dataset.path, value);
		// An empty pushPolicyByAuthor map is no map.
		const m = /^(\/personal\/repos\/\d+)\/pushPolicyByAuthor\//.exec(el.dataset.path);
		if (m) {
			const repo = draft.personal.repos[Number(fromPointer(m[1]!)[2])];
			if (repo?.pushPolicyByAuthor && !Object.keys(repo.pushPolicyByAuthor).length) delete repo.pushPolicyByAuthor;
		}
		const r = /^\/personal\/reviewTeams\/([^/]+)$/.exec(el.dataset.path);
		if (r && Array.isArray(value) && !value.length) delete draft.personal.reviewTeams[fromPointer(el.dataset.path)[2]!];
		const pill = dialog.querySelector<HTMLElement>('[data-s-dirty]');
		if (pill) pill.hidden = !dirty();
	});

	dialog.addEventListener('change', (e) => {
		const el = e.target;
		if (!draft || !(el instanceof HTMLInputElement)) return;
		if ('sLinear' in el.dataset) {
			draft.personal.linear = el.checked ? { workspace: '', keys: [] } : null;
			renderFocus('[data-s-linear]');
		}
	});
	// A new host's key, and an org of a host's bots per org: renaming moves the entry to the new key, in the same place.
	dialog.addEventListener('change', (e) => {
		const el = e.target;
		if (!draft || !(el instanceof HTMLInputElement)) return;
		const hosts = draft.deployment.hosts;
		const rename = <T,>(map: Record<string, T>, from: string, to: string): Record<string, T> =>
			Object.fromEntries(Object.entries(map).map(([k, v]) => [k === from ? to : k, v]));
		const refuse = (path: string, message: string) => {
			errors = [...errors.filter((x) => x.path !== path), { path, code: 'invalid', message }];
			render();
		};
		if (el.dataset.sHostKey !== undefined) {
			const from = el.dataset.sHostKey;
			const to = el.value.trim();
			if (to === from) return;
			if (!to || Object.hasOwn(hosts, to)) return refuse(toPointer(['deployment', 'hosts', from]), to ? `There is already a host "${to}".` : 'A host needs a key.');
			draft.deployment.hosts = rename(hosts, from, to);
			if (Object.hasOwn(draft.personal.reviewTeams, from)) draft.personal.reviewTeams = rename(draft.personal.reviewTeams, from, to);
			for (const m of draft.personal.team) if (Object.hasOwn(m.logins, from)) m.logins = rename(m.logins, from, to);
			renderFocus(`[data-s-host-key="${CSS.escape(to)}"]`);
		} else if (el.dataset.sOrgKey !== undefined && el.dataset.host !== undefined) {
			const host = hosts[el.dataset.host];
			const from = el.dataset.sOrgKey;
			const to = el.value.trim();
			if (!host?.botsByOwner || to === from) return;
			if (Object.hasOwn(host.botsByOwner, to)) {
				el.value = from;
				return refuse(toPointer(['deployment', 'hosts', el.dataset.host, 'botsByOwner', from]), `${to} already has a bot on this host.`);
			}
			host.botsByOwner = rename(host.botsByOwner, from, to);
			render();
		}
	});
	// Renaming a per-author entry moves its policy to the new key, in the same place.
	dialog.addEventListener('change', (e) => {
		const el = e.target;
		if (!draft || !(el instanceof HTMLInputElement) || el.dataset.sAuthorKey === undefined) return;
		const repo = draft.personal.repos[Number(el.dataset.repo)];
		const from = el.dataset.sAuthorKey;
		const to = el.value.trim();
		if (!repo?.pushPolicyByAuthor || to === from) return;
		if (Object.hasOwn(repo.pushPolicyByAuthor, to)) {
			// Two entries for one author would leave only one of them: keep the old key and say why.
			el.value = from;
			errors = [
				...errors.filter((x) => x.path !== toPointer(['personal', 'repos', Number(el.dataset.repo), 'pushPolicyByAuthor', from])),
				{ path: toPointer(['personal', 'repos', Number(el.dataset.repo), 'pushPolicyByAuthor', from]), code: 'invalid', message: `${to} already has a policy in this repo.` },
			];
			render();
			return;
		}
		repo.pushPolicyByAuthor = Object.fromEntries(Object.entries(repo.pushPolicyByAuthor).map(([k, v]) => [k === from ? to : k, v]));
		render();
	});
	// The viewer's own fields follow the `me` choice.
	dialog.addEventListener('change', (e) => {
		if (e.target instanceof HTMLSelectElement && e.target.dataset.path === '/personal/me') renderFocus('[data-path="/personal/me"]');
	});

	dialog.addEventListener('click', (e) => {
		const t = e.target instanceof Element ? e.target.closest<HTMLElement>('button') : null;
		if (!t || !draft) {
			if (t && 'sClose' in t.dataset) dialog.close();
			return;
		}
		const ds = t.dataset;
		if ('sClose' in ds) {
			dialog.close();
		} else if (ds.sSection) {
			view = { section: ds.sSection as Section };
			renderFocus(`[data-s-section="${ds.sSection}"]`);
		} else if (ds.sPerson !== undefined) {
			const i = Number(ds.sPerson);
			view.person = view.person === i ? undefined : i;
			renderFocus(`.s-row-head[data-s-person="${i}"]`);
		} else if (ds.sRepo !== undefined) {
			const i = Number(ds.sRepo);
			view.repo = view.repo === i ? undefined : i;
			renderFocus(`.s-row-head[data-s-repo="${i}"]`);
		} else if (ds.sAdd === 'team') {
			draft.personal.team.push({ id: '', name: '', short: '', logins: {} });
			view.person = draft.personal.team.length - 1;
			renderFocus(`[data-path="/personal/team/${view.person}/name"]`);
		} else if (ds.sAdd === 'repos') {
			draft.personal.repos.push({ host: hostKeys()[0] ?? '', owner: '', name: '', short: '' });
			view.repo = draft.personal.repos.length - 1;
			renderFocus(`[data-path="/personal/repos/${view.repo}/owner"]`);
		} else if (ds.sRemove) {
			const [, kind, index] = fromPointer(ds.sRemove);
			if (kind === 'team') draft.personal.team.splice(Number(index), 1);
			if (kind === 'repos') draft.personal.repos.splice(Number(index), 1);
			view.person = view.repo = undefined;
			// Errors point at indexes that moved.
			errors = [];
			render();
		} else if (ds.sAuthorAdd !== undefined) {
			const repo = draft.personal.repos[Number(ds.sAuthorAdd)];
			if (!repo) return;
			const map = (repo.pushPolicyByAuthor ??= {});
			// Start with the first person who has no entry yet; the key can be changed to any login.
			const key = draft.personal.team.map((m) => m.id).find((id) => !Object.hasOwn(map, id)) ?? '';
			map[key] = 'review-only';
			render();
		} else if (ds.sAuthorRemove !== undefined) {
			const repo = draft.personal.repos[Number(ds.repo)];
			if (repo?.pushPolicyByAuthor) {
				delete repo.pushPolicyByAuthor[ds.sAuthorRemove];
				if (!Object.keys(repo.pushPolicyByAuthor).length) delete repo.pushPolicyByAuthor;
			}
			errors = [];
			render();
		} else if ('sHostAdd' in ds) {
			const hosts = draft.deployment.hosts;
			let key = 'host';
			for (let n = 2; Object.hasOwn(hosts, key); n++) key = `host${n}`;
			hosts[key] = { hostname: '', label: '', bot: null };
			renderFocus(`[data-path="${toPointer(['deployment', 'hosts', key, 'hostname'])}"]`);
		} else if (ds.sHostRemove !== undefined) {
			const key = ds.sHostRemove;
			const repos = draft.personal.repos.filter((r) => r.host === key);
			if (repos.length) {
				// The repos would point at a host that is gone: say which, and keep the host.
				const path = toPointer(['deployment', 'hosts', key]);
				errors = [
					...errors.filter((x) => x.path !== path),
					{ path, code: 'invalid', message: `Remove the repos on this host first: ${repos.map((r) => `${r.owner}/${r.name}`).join(', ')}.` },
				];
				render();
				return;
			}
			delete draft.deployment.hosts[key];
			// The logins and review teams on the host go with it, since the panel has no field left for them.
			for (const m of draft.personal.team) if (Object.hasOwn(m.logins, key)) delete m.logins[key];
			if (Object.hasOwn(draft.personal.reviewTeams, key)) delete draft.personal.reviewTeams[key];
			errors = [];
			render();
		} else if (ds.sOrgAdd !== undefined) {
			const host = draft.deployment.hosts[ds.sOrgAdd];
			if (!host) return;
			const map = (host.botsByOwner ??= {});
			let key = 'org';
			for (let n = 2; Object.hasOwn(map, key); n++) key = `org${n}`;
			map[key] = null;
			renderFocus(`[data-s-org-key="${key}"][data-host="${CSS.escape(ds.sOrgAdd)}"]`);
		} else if (ds.sOrgRemove !== undefined && ds.host !== undefined) {
			const host = draft.deployment.hosts[ds.host];
			if (host?.botsByOwner) {
				delete host.botsByOwner[ds.sOrgRemove];
				if (!Object.keys(host.botsByOwner).length) delete host.botsByOwner;
			}
			errors = [];
			render();
		} else if ('sExport' in ds) {
			exportFile();
		} else if ('sImport' in ds) {
			pickImport();
		} else if ('sReload' in ds && dialog.dataset.fresh) {
			const fresh = JSON.parse(dialog.dataset.fresh) as SettingsResponse;
			delete dialog.dataset.fresh;
			errors = [];
			notice = null;
			show(fresh);
		}
	});

	dialog.addEventListener('submit', (e) => {
		e.preventDefault();
		void submit();
	});

	return {
		async open() {
			if (!dialog.open) dialog.showModal();
			await load();
		},
	};
}
