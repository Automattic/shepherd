// Shepherd PR dashboard — client.
// Every row owns its own fetch lifecycle (queue slot, AbortController, timers),
// so rows refresh independently and update in place.

import type {
	LastActivity,
	PaneLink,
	PaneMatchPr,
	PaneSignal,
	BotFinding,
	DetailResponse,
	LightPr,
	ListResponse,
	PrDetail,
	PublicConfig,
	RateLimit,
	Severity,
	TeamMember,
} from '../src/types.ts';
import { changesRequestedPending, isTurnOf, WAIT_REASON_TEXT, waitReasons, type WaitReason } from '../src/waiting.ts';

// ---------------------------------------------------------------------------
// Types

type CellName = 'pr' | 'wait' | 'appr' | 'bot' | 'ppl' | 'status' | 'upd';
type TileId = 'me' | 'approved' | 'changes' | 'bot';
type Theme = 'light' | 'dark';

interface Row {
	key: string;
	light: LightPr;
	detail: PrDetail | null;
	el: { root: HTMLDivElement } & Record<CellName, HTMLElement>;
	/** Last HTML written to each cell, to skip no-op updates. */
	html: Partial<Record<CellName, string>>;
	fetching: boolean;
	queued: boolean;
	force: boolean;
	lastFetch: number;
	/** List refreshes in a row that did not return this PR. */
	missing: number;
	error: string | null;
	gone: boolean;
	/** Still on screen while it animates out after `gone`. */
	leavingVisible: boolean;
	groupKey: string | null;
	depth: number;
	parentKey: string | null;
}

interface Group {
	key: string;
	members: Row[];
	you: boolean;
	/** Every open PR in the group (the whole stack) is approved. */
	approved: boolean;
	/** A stack where some, but not all, open PRs are approved. */
	partial: boolean;
	/** Approved, but a PR in the group has merge conflicts or failed checks. */
	blocked: boolean;
	updated: number;
}

interface Settings {
	interval: number;
	theme: Theme | null;
	/** Null until boot defaults it to `[cfg.me]`. */
	reviewers: string[] | null;
	/** Show only PRs written by these team member ids. */
	people: string[];
	/** Show only PRs that directly request a review from these team member ids. */
	waitingOn: string[];
	repos: string[];
	drafts: boolean;
	dormant: boolean;
	/** Filter like the repo chips: when either is set, show only groups of the selected kinds. */
	onlyApproved: boolean;
	onlyPartial: boolean;
	tile: TileId | null;
	q: string;
}

interface Tile {
	id: TileId | null;
	cls: string;
	icon: string;
	label: string;
	value: number;
	note?: string;
}

// ---------------------------------------------------------------------------
// DOM and narrowing helpers

function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
	const el = root.querySelector<T>(sel);
	if (!el) throw new Error(`Missing element: ${sel}`);
	return el;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function errorName(e: unknown): unknown {
	return isRecord(e) ? e.name : undefined;
}

function errorMessage(e: unknown): string {
	return isRecord(e) && typeof e.message === 'string' ? e.message : String(e);
}

/** The `error` field of an `ErrorResponse`, or '' when the body has none. */
function responseError(body: unknown): string {
	return isRecord(body) && typeof body.error === 'string' ? body.error : '';
}

// The server is ours, so these check only the top-level shape before trusting the rest.
function isPublicConfig(v: unknown): v is PublicConfig {
	return (
		isRecord(v) &&
		typeof v.me === 'string' &&
		Array.isArray(v.team) &&
		Array.isArray(v.repos) &&
		isRecord(v.hosts) &&
		(v.linear === null || isRecord(v.linear)) &&
		typeof v.aiReviewLabel === 'string'
	);
}

function isListResponse(v: unknown): v is ListResponse {
	return isRecord(v) && Array.isArray(v.prs);
}

function isDetailResponse(v: unknown): v is DetailResponse {
	return isRecord(v) && isRecord(v.pr);
}

const isTileId = (v: string): v is TileId => v === 'me' || v === 'approved' || v === 'changes' || v === 'bot';

// ---------------------------------------------------------------------------
// Constants

const INTERVALS: readonly { label: string; ms: number }[] = [
	{ label: '5s', ms: 5_000 },
	{ label: '30s', ms: 30_000 },
	{ label: '1m', ms: 60_000 },
	{ label: '5m', ms: 300_000 },
	{ label: '15m', ms: 900_000 },
];
const DORMANT_MS = 60 * 24 * 3600 * 1000;
const DEFAULT_BRANCHES: ReadonlySet<string> = new Set(['trunk', 'main', 'master', 'develop']);
const MAX_PARALLEL = 5; // leaves one browser connection free for the list call

// ---------------------------------------------------------------------------
// Settings

const SETTINGS_KEY = 'shepherd.settings';
const LEGACY_SETTINGS_KEY = 'teamwork.settings'; // saved before the rename to Shepherd

function loadSettings(): Settings {
	const settings: Settings = {
		interval: 60_000,
		theme: null,
		reviewers: null,
		people: [],
		waitingOn: [],
		repos: [],
		drafts: true,
		dormant: false,
		onlyApproved: false,
		onlyPartial: false,
		tile: null,
		q: '',
	};
	let saved: unknown;
	try {
		saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(LEGACY_SETTINGS_KEY) || '{}');
	} catch {
		saved = {};
	}
	// Saved values overlay the defaults as-is, like the original Object.assign.
	if (isRecord(saved)) Object.assign(settings, saved);
	return settings;
}

const S: Settings = loadSettings();

const save = (): void => {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(S));
	} catch {
		/* storage unavailable */
	}
};

const reviewers = (): string[] => S.reviewers ?? [];

// ---------------------------------------------------------------------------
// State

// Assigned in boot() before anything reads it.
let cfg: PublicConfig;
const memberByLogin = new Map<string, TeamMember>(); // lowercased login (either host) -> member
const rows = new Map<string, Row>(); // key -> row
const groupEls = new Map<string, HTMLDivElement>(); // root key -> element
let lastList: number | null = null;
let hostErrors: Record<string, string> = {};
let rate: Record<string, RateLimit> = {};
let listBusy = false;
/** Groups from the latest layout, for the approval chip counts. */
let lastGroups: Group[] = [];
let tickTimer: ReturnType<typeof setTimeout> | undefined;

/** A member's login on a host key. */
function loginOn(m: TeamMember | undefined, host: string): string | undefined {
	return m?.logins[host];
}

/** True when a host key points at github.com (public avatars, the rate-limited API). */
const isDotcom = (host: string): boolean => cfg.hosts[host]?.hostname === 'github.com';
/** The host key for github.com, if one is configured. */
const dotcomHost = (): string | undefined => Object.keys(cfg.hosts).find(isDotcom);
const hostIcon = (host: string): string => (isDotcom(host) ? 'fa-brands fa-github' : 'fa-solid fa-building-shield');

const meMember = (): TeamMember | undefined => cfg.team.find((m) => m.id === cfg.me);
const isMe = (login: string | null | undefined, host: string): boolean =>
	(login || '').toLowerCase() === (loginOn(meMember(), host) || '').toLowerCase();
const member = (login: string | null | undefined): TeamMember | null => memberByLogin.get((login || '').toLowerCase()) || null;
const repoShort = (host: string, owner: string, name: string): string =>
	cfg.repos.find((r) => r.host === host && r.owner === owner && r.name === name)?.short || name;
const linearUrl = (key: string): string => `https://linear.app/${cfg.linear?.workspace ?? ''}/issue/${key}`;

// ---------------------------------------------------------------------------
// Small render helpers

function relTime(iso: string | null | undefined): string {
	if (!iso) return '';
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	if (s < 86400 * 14) return `${Math.round(s / 86400)}d ago`;
	if (s < 86400 * 120) return `${Math.round(s / 604800)}w ago`;
	return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function hue(str: string): number {
	let h = 0;
	for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360;
	return h;
}

function initials(login: string): string {
	const m = member(login);
	const name = m?.name || login;
	const parts = name.split(/[\s._-]+/).filter(Boolean);
	return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function displayName(login: string): string {
	return member(login)?.short || login;
}

function avatar(login: string, host: string): string {
	const m = member(login);
	// Avatars come from github.com, so use the person's github.com login when one is known.
	const dotcom = dotcomHost();
	const gh = m ? (dotcom ? m.logins[dotcom] : undefined) : isDotcom(host) ? login : undefined;
	const title = esc(m?.name || login);
	if (gh) {
		return `<img class="avatar" src="https://github.com/${encodeURIComponent(gh)}.png?size=64" alt="" title="${title}" loading="lazy" data-login="${esc(login)}">`;
	}
	return initialsAvatar(login);
}

function initialsAvatar(login: string): string {
	return `<span class="avatar" style="background:hsl(${hue(login)} 45% 48%)" title="${esc(member(login)?.name || login)}">${esc(initials(login))}</span>`;
}

// Replace broken avatar images with initials.
document.addEventListener(
	'error',
	(e) => {
		const img = e.target;
		if (img instanceof HTMLImageElement && img.classList.contains('avatar')) {
			img.outerHTML = initialsAvatar(img.dataset.login || '?');
		}
	},
	true
);

const skel = (w: number): string => `<span class="skel" style="width:${w}px"></span>`;

// ---------------------------------------------------------------------------
// Row model

function rowKeyOf(host: string, owner: string, repo: string, number: number): string {
	return `${host}:${owner}/${repo}#${number}`;
}

function linearKeysLight(light: LightPr): Set<string> {
	const keys = new Set<string>();
	if (!cfg.linear?.keys.length) return keys;
	const re = new RegExp(`\\b(${cfg.linear.keys.join('|')})-(\\d+)\\b`, 'gi');
	for (const [, prefix = '', num = ''] of `${light.title}\n${light.headRefName}`.matchAll(re)) keys.add(`${prefix.toUpperCase()}-${num}`);
	return keys;
}

function linearKeys(row: Row): Set<string> {
	return row.detail ? new Set(row.detail.linear) : linearKeysLight(row.light);
}

/** Approved: GitHub's review decision says so, or someone approved and nobody asked for changes. */
/** Merge conflicts or failed checks stand between this PR and merging. Pending checks don't count. */
function hasBlockers(row: Row): boolean {
	const d = row.detail;
	if (!d) return false;
	const checks = (d.checks ?? '').toUpperCase();
	return d.mergeable === 'CONFLICTING' || checks === 'FAILURE' || checks === 'ERROR';
}

function isApproved(row: Row): boolean {
	const d = row.detail;
	if (!d || d.state !== 'OPEN') return false;
	if (d.reviewDecision === 'APPROVED') return true;
	return d.reviews.some((r) => r.state === 'APPROVED') && !d.reviews.some((r) => r.state === 'CHANGES_REQUESTED');
}

/** True when the PR directly requests a review from this team member. */
/** Why a PR waits on a team member (see src/waiting.ts); before details load, only direct review requests are known. */
function waitReasonsFor(row: Row, id: string): WaitReason[] {
	const m = cfg.team.find((t) => t.id === id);
	if (!m) return [];
	if (row.detail) return waitReasons(row.detail, m);
	return row.light.requestedFor.includes(id) ? ['requested'] : [];
}

function waitingOnMember(row: Row, id: string): boolean {
	return waitReasonsFor(row, id).length > 0;
}

function waitingOnMe(row: Row): boolean {
	return waitingOnMember(row, cfg.me);
}

function isDormant(row: Row): boolean {
	return Date.now() - new Date(row.light.updatedAt).getTime() > DORMANT_MS;
}

function createRow(light: LightPr): Row {
	const root = document.createElement('div');
	root.className = 'row';
	root.dataset.key = light.key;
	root.innerHTML = `
		<div class="c-pr"></div>
		<div class="c-wait"></div>
		<div class="c-appr"></div>
		<div class="c-bot"></div>
		<div class="c-ppl"></div>
		<div class="c-status"></div>
		<div class="c-upd"></div>`;
	const q = (c: string): HTMLElement => $(c, root);
	return {
		key: light.key,
		light,
		detail: null,
		el: { root, pr: q('.c-pr'), wait: q('.c-wait'), appr: q('.c-appr'), bot: q('.c-bot'), ppl: q('.c-ppl'), status: q('.c-status'), upd: q('.c-upd') },
		html: {},
		fetching: false,
		queued: false,
		force: false,
		lastFetch: 0,
		missing: 0,
		error: null,
		gone: false,
		leavingVisible: false,
		groupKey: null,
		depth: 0,
		parentKey: null,
	};
}

function setCell(row: Row, name: CellName, html: string, flash = true): void {
	if (row.html[name] === html) return;
	const prev = row.html[name];
	const el = row.el[name];
	el.innerHTML = html;
	row.html[name] = html;
	if (flash && prev !== undefined && !prev.includes('class="skel"')) {
		el.classList.remove('flash');
		void el.offsetWidth; // restart the animation
		el.classList.add('flash');
	}
}

// ---------------------------------------------------------------------------
// Cells

type PrVisualState = 'open' | 'draft' | 'merged' | 'closed';
const STATE_ICONS: Record<PrVisualState, string> = {
	open: 'fa-solid fa-code-pull-request',
	draft: 'fa-regular fa-file-lines',
	merged: 'fa-solid fa-code-merge',
	closed: 'fa-solid fa-circle-xmark',
};

function cellPr(row: Row): string {
	const l = row.light;
	const d = row.detail;
	const state: PrVisualState = d?.state === 'MERGED' ? 'merged' : d?.state === 'CLOSED' ? 'closed' : l.isDraft ? 'draft' : 'open';
	const icon = STATE_ICONS[state];
	const repoIcon = hostIcon(l.host);

	const meta: string[] = [];
	meta.push(
		`<span class="repo-pill" title="${esc(cfg.hosts[l.host]?.hostname)}/${esc(l.owner)}/${esc(l.repo)}"><i class="${repoIcon}"></i>${esc(repoShort(l.host, l.owner, l.repo))}</span>`
	);
	meta.push(`<a class="num" href="${esc(l.url)}" target="_blank" rel="noopener">#${l.number}</a>`);
	if (row.depth === 0 || member(l.author.login) === null || !sameAuthorAsParent(row)) {
		meta.push(`<span class="meta-item">${avatar(l.author.login, l.host)}${esc(displayName(l.author.login))}</span>`);
	}
	for (const k of linearKeys(row)) {
		meta.push(`<a class="linear" href="${linearUrl(k)}" target="_blank" rel="noopener" title="Open ${k} in Linear"><i class="fa-solid fa-ticket"></i>${k}</a>`);
	}
	meta.push(...herdrChips(row));
	meta.push(...assocChips(row));
	if (row.depth === 0 && !DEFAULT_BRANCHES.has(l.baseRefName) && !d?.parent) {
		meta.push(`<span class="branch" title="Base branch"><i class="fa-solid fa-code-branch"></i> ${esc(l.baseRefName)}</span>`);
	}

	return `
		<div class="title-line">
			<i class="state-ico ${state} ${icon}" title="${state}"></i>
			<a class="pr-title" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.title)}">${esc(l.title)}</a>
		</div>
		<div class="pr-meta">${meta.join('')}</div>`;
}

function sameAuthorAsParent(row: Row): boolean {
	const parent = row.parentKey ? rows.get(row.parentKey) : undefined;
	return !!parent && parent.light.author.login === row.light.author.login;
}

function assocChips(row: Row): string[] {
	const l = row.light;
	const d = row.detail;
	const chips = new Map<string, string>(); // key -> html
	const add = (key: string, html: string): void => {
		if (!chips.has(key)) chips.set(key, html);
	};
	const tracked = (key: string): Row | null => {
		const r = rows.get(key);
		return r && !r.gone ? r : null;
	};
	const inMyGroup = (key: string): boolean => tracked(key)?.groupKey === row.groupKey;
	const chip = (key: string, url: string, label: string, title: string, extra = ''): string => {
		const r = tracked(key);
		const st = r?.detail?.state === 'MERGED' ? 'merged' : r ? 'open' : '';
		return `<a class="assoc" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title)}">${extra}<span class="dot ${st}"></span>${esc(label)}</a>`;
	};

	if (d?.parent) {
		const pk = rowKeyOf(l.host, l.owner, l.repo, d.parent.number);
		if (!tracked(pk)) {
			add(pk, chip(pk, d.parent.url, `on #${d.parent.number}`, `Stacked on #${d.parent.number} by ${d.parent.author}: ${d.parent.title}`, '<i class="fa-solid fa-layer-group"></i>'));
		}
	}
	for (const s of d?.stackedOnThis || []) {
		const sk = rowKeyOf(l.host, l.owner, l.repo, s.number);
		if (!tracked(sk)) add(sk, chip(sk, s.url, `#${s.number} on this`, `#${s.number} by ${s.author} is stacked on this: ${s.title}`, '<i class="fa-solid fa-layer-group"></i>'));
	}
	for (const ref of d?.refs || []) {
		if (inMyGroup(ref.key)) continue;
		const label = `${repoShort(ref.host, ref.owner, ref.repo)}#${ref.number}`;
		const t = tracked(ref.key);
		add(ref.key, chip(ref.key, ref.url, label, t ? `Mentioned: ${t.light.title}` : 'Mentioned in the description', '<i class="fa-solid fa-link"></i>'));
	}
	for (const n of d?.hashRefs || []) {
		const k = rowKeyOf(l.host, l.owner, l.repo, n);
		const t = tracked(k);
		if (!t || inMyGroup(k)) continue;
		add(k, chip(k, t.light.url, `#${n}`, `Mentioned: ${t.light.title}`, '<i class="fa-solid fa-link"></i>'));
	}
	const mine = linearKeys(row);
	if (mine.size) {
		for (const other of rows.values()) {
			if (other === row || other.gone || other.groupKey === row.groupKey) continue;
			const shared = [...linearKeys(other)].find((k) => mine.has(k));
			if (!shared) continue;
			const ol = other.light;
			add(other.key, chip(other.key, ol.url, `${repoShort(ol.host, ol.owner, ol.repo)}#${ol.number}`, `Same ticket (${shared}): ${ol.title}`, '<i class="fa-solid fa-ticket"></i>'));
		}
	}
	const all = [...chips.values()];
	if (all.length > 5) return [...all.slice(0, 5), `<span class="assoc" title="${all.length - 5} more related pull requests">+${all.length - 5}</span>`];
	return all;
}

function cellWait(row: Row): string {
	const d = row.detail;
	const host = row.light.host;
	if (!d) {
		return row.light.requestedFor.includes(cfg.me)
			? `<span class="you-pill">${avatar(loginOn(meMember(), host) ?? '', host)}You</span>`
			: skel(70);
	}
	const parts: string[] = [];
	const users = [...d.requested.users].sort((a, b) => Number(isMe(b.login, host)) - Number(isMe(a.login, host)));
	for (const u of users) {
		if (isMe(u.login, host)) {
			parts.push(`<span class="you-pill" title="Your review is requested">${avatar(u.login, host)}You</span>`);
			continue;
		}
		const m = member(u.login);
		const watched = m && reviewers().includes(m.id);
		parts.push(`<span class="avatar-wrap ${watched ? 'watch' : ''}" title="${esc(m?.name || u.name || u.login)}">${avatar(u.login, host)}</span>`);
	}
	// Beyond review requests: your turn, and changes waiting on the author.
	const mine = waitReasonsFor(row, cfg.me);
	if (!mine.includes('requested') && mine.length) {
		const why = mine.map((r) => WAIT_REASON_TEXT[r]).join('; ');
		parts.unshift(`<span class="you-pill" title="Waiting on you: ${esc(why)}">${avatar(loginOn(meMember(), host) ?? '', host)}You</span>`);
	}
	if (changesRequestedPending(d) && !isMe(d.author.login, host)) {
		parts.push(
			`<span class="author-pill" title="Changes requested; waiting on ${esc(member(d.author.login)?.name || d.author.login)} to push">${avatar(d.author.login, host)}Author</span>`
		);
	}
	const teams = d.requested.teams;
	for (const t of teams.slice(0, 2)) parts.push(`<span class="team-chip" title="Team: ${esc(t.name)}"><i class="fa-solid fa-users"></i>${esc(t.slug)}</span>`);
	if (teams.length > 2) parts.push(`<span class="team-chip" title="${esc(teams.slice(2).map((t) => t.slug).join(', '))}">+${teams.length - 2}</span>`);
	if (!parts.length) return `<span class="muted">—</span>`;
	return `<div class="stack">${parts.join('')}</div>`;
}

function cellApprovals(row: Row): string {
	const d = row.detail;
	if (!d) return skel(56);
	const host = row.light.host;
	const approved = d.reviews.filter((r) => r.state === 'APPROVED');
	const changes = d.reviews.filter((r) => r.state === 'CHANGES_REQUESTED');
	if (!approved.length && !changes.length) return `<span class="muted">None yet</span>`;
	const badge = (r: PrDetail['reviews'][number]): string => {
		const ok = r.state === 'APPROVED';
		const who = esc(member(r.login)?.name || r.login);
		const verb = ok ? 'approved' : 'requested changes';
		return `<span class="avatar-wrap ${isMe(r.login, host) ? 'you' : ''}" title="${who} ${verb} ${esc(relTime(r.submittedAt))}">${avatar(r.login, host)}<span class="badge ${ok ? 'ok' : 'bad'}"><i class="fa-solid ${ok ? 'fa-check' : 'fa-xmark'}"></i></span></span>`;
	};
	const all = [...approved, ...changes];
	const names =
		all.length <= 2
			? `<span class="appr-names">${all.map((r) => esc(isMe(r.login, host) ? 'You' : displayName(r.login))).join(', ')}</span>`
			: `<span class="appr-names">${approved.length} approved${changes.length ? `, ${changes.length} changes` : ''}</span>`;
	return `<div class="stack">${all.map(badge).join('')}${names}</div>`;
}

function cellBot(row: Row): string {
	const hostCfg = cfg.hosts[row.light.host];
	if (!hostCfg?.bot) return `<span class="muted" title="No ${esc(cfg.aiReviewLabel)} bot on ${esc(hostCfg?.hostname)}">n/a</span>`;
	const d = row.detail;
	if (!d) return skel(48);
	const b = d.bot;
	if (!b || !b.open) return `<span class="bot-clear"><i class="fa-solid fa-circle-check"></i>Clear</span>`;
	const minor = b.open - b.blocking;
	// Only repeat the numbers when the total is split across both kinds.
	const both = b.blocking && minor;
	const split = [
		b.blocking ? `<span class="sev block" title="${b.blocking} medium or higher, not nits">${both ? `${b.blocking} ` : ''}fix</span>` : '',
		minor ? `<span class="sev minor" title="${minor} low, info or nit">${both ? `${minor} ` : ''}minor</span>` : '',
	].join('');
	const outdated = b.outdated ? `, ${b.outdated} on outdated code` : '';
	return `<button class="bot-btn" data-bot="${esc(row.key)}" title="${b.open} unresolved ${esc(cfg.aiReviewLabel)} thread${b.open === 1 ? '' : 's'}${outdated}"><i class="fa-solid fa-robot"></i><span class="n">${b.open}</span><span class="split">${split}</span></button>`;
}

function cellParticipants(row: Row): string {
	const d = row.detail;
	if (!d) return skel(60);
	const host = row.light.host;
	const people = d.participants || [];
	const latest = people[0];
	const label = (p: { login: string }): string => (isMe(p.login, host) ? 'You' : displayName(p.login));
	const last = lastActivityLine(row);
	if (!latest) return `<div class="ppl-top"><span class="muted">Nobody yet</span></div>${last}`;
	const shown = people.slice(0, 5).map((p) => {
		const when = p.lastActive ? `active ${relTime(p.lastActive)}` : 'no activity yet';
		return `<span class="avatar-wrap ${isMe(p.login, host) ? 'you' : ''}" title="${esc(member(p.login)?.name || p.name || p.login)} · ${esc(when)}">${avatar(p.login, host)}</span>`;
	});
	const more = people.length > 5 ? `<span class="pile-more" title="${esc(people.slice(5).map(label).join(', '))}">+${people.length - 5}</span>` : '';
	const names =
		people.length <= 2
			? people.map(label).join(', ')
			: `${label(latest)}${latest.lastActive ? ` ${relTime(latest.lastActive).replace(' ago', '')}` : ''}`;
	return `<div class="ppl-top"><div class="pile">${shown.join('')}${more}</div><span class="appr-names" title="Most recently active first">${esc(names)}</span></div>${last}`;
}

const ACTIVITY_ICONS: Record<LastActivity['kind'], string> = {
	comment: 'fa-regular fa-comment',
	review: 'fa-regular fa-eye',
	commit: 'fa-solid fa-code-commit',
};

/**
 * Who acted last (author included, bots excluded). Marked as "your turn" when someone else
 * had the last word on a PR you wrote or took part in.
 */
function lastActivityLine(row: Row): string {
	const d = row.detail;
	const a = d?.lastActivity;
	if (!d || !a) return '';
	const host = row.light.host;
	const mine = isMe(a.login, host);
	const me = meMember();
	const yourTurn = me ? isTurnOf(d, me) : false;
	const isAuthor = a.login === d.author.login;
	const who = mine ? 'You' : displayName(a.login);
	const verb = { comment: 'commented', review: 'reviewed', commit: 'pushed' }[a.kind];
	const title = `${mine ? 'You' : member(a.login)?.name || a.login}${isAuthor ? ' (author)' : ''} ${verb} ${relTime(a.at)}${yourTurn ? ' — your turn' : ''}`;
	return `<span class="last-act ${yourTurn ? 'turn' : ''}" title="${esc(title)}"><i class="${ACTIVITY_ICONS[a.kind]}"></i>${esc(who)}${isAuthor && !mine ? ' (author)' : ''} · ${esc(relTime(a.at).replace(' ago', ''))}</span>`;
}

const CI_ICONS: Record<string, string> = {
	success: 'fa-solid fa-circle-check',
	failure: 'fa-solid fa-circle-xmark',
	error: 'fa-solid fa-circle-exclamation',
	pending: 'fa-solid fa-circle-half-stroke',
	expected: 'fa-regular fa-clock',
};

function cellStatus(row: Row): string {
	const d = row.detail;
	const parts: string[] = [];
	if (d?.state === 'MERGED') parts.push(`<span class="merged-pill"><i class="fa-solid fa-code-merge"></i> Merged</span>`);
	else if (d?.state === 'CLOSED') parts.push(`<span class="draft-pill">Closed</span>`);
	else if (row.light.isDraft) parts.push(`<span class="draft-pill">Draft</span>`);
	if (!d) return parts.join('') || skel(40);
	const ci = (d.checks || '').toLowerCase();
	const ciIcon = CI_ICONS[ci];
	if (ciIcon) parts.push(`<i class="ci-${ci} ${ciIcon}" title="Checks: ${ci}"></i>`);
	if (d.mergeable === 'CONFLICTING') parts.push(`<i class="conflict fa-solid fa-code-compare" title="Merge conflicts"></i>`);
	if (d.reviewDecision === 'APPROVED' && d.state === 'OPEN') parts.push(`<i class="fa-solid fa-thumbs-up" style="color:var(--ok)" title="Review decision: approved"></i>`);
	if (d.size) parts.push(`<span class="size" title="${d.size.files} files"><span class="add">+${d.size.additions}</span> <span class="del">−${d.size.deletions}</span></span>`);
	return `<div class="status">${parts.join('')}</div>`;
}

function cellUpdated(row: Row): string {
	const busy = row.fetching || row.queued;
	const checked = row.lastFetch ? `checked ${relTime(new Date(row.lastFetch).toISOString())}` : 'not checked yet';
	const title = row.error ? `Last refresh failed: ${row.error}` : `Updated ${new Date(row.light.updatedAt).toLocaleString()} · ${checked}`;
	const icon = row.error ? 'fa-solid fa-triangle-exclamation' : 'fa-solid fa-rotate';
	return `<span class="upd-time" title="${esc(title)}">${esc(relTime(row.light.updatedAt))}</span><button class="row-refresh ${busy ? 'busy' : ''} ${row.error ? 'err' : ''}" data-refresh="${esc(row.key)}" title="${esc(title)} — click to refresh this row"><i class="${icon}"></i></button>`;
}

function renderRow(row: Row): void {
	row.el.root.classList.toggle('child', row.depth > 0);
	// One level of indent shows the stack; deeper PRs stay in order at the same inset.
	row.el.root.style.setProperty('--depth', String(Math.min(row.depth, 1)));
	row.el.root.classList.toggle('merged', row.detail?.state === 'MERGED');
	row.el.root.classList.toggle('closed', row.detail?.state === 'CLOSED');
	setCell(row, 'pr', cellPr(row), false);
	setCell(row, 'wait', cellWait(row));
	setCell(row, 'appr', cellApprovals(row));
	setCell(row, 'bot', cellBot(row));
	setCell(row, 'ppl', cellParticipants(row));
	setCell(row, 'status', cellStatus(row));
	setCell(row, 'upd', cellUpdated(row), false);
}

// ---------------------------------------------------------------------------
// Filters

function inScope(row: Row): boolean {
	if (row.gone) return false;
	if (!S.drafts && row.light.isDraft) return false;
	if (!S.dormant && isDormant(row) && !waitingOnMe(row)) return false;
	return true;
}

function matchesFilters(row: Row, { ignoreTile = false }: { ignoreTile?: boolean } = {}): boolean {
	if (!inScope(row)) return false;
	const l = row.light;
	if (S.repos.length && !S.repos.includes(repoShort(l.host, l.owner, l.repo))) return false;
	// Names filter by owner; clocks by whose review is waiting. Each is "any of", and the two combine with AND.
	if (S.people.length) {
		const authorId = member(l.author.login)?.id;
		if (authorId === undefined || !S.people.includes(authorId)) return false;
	}
	if (S.waitingOn.length && !S.waitingOn.some((id) => waitingOnMember(row, id))) return false;
	if (S.q) {
		const hay = `${l.title} ${l.headRefName} ${l.repo} #${l.number} ${l.author.login} ${displayName(l.author.login)} ${[...linearKeys(row)].join(' ')}`.toLowerCase();
		if (!S.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
	}
	if (!ignoreTile && S.tile) {
		const d = row.detail;
		if (S.tile === 'me' && !waitingOnMe(row)) return false;
		if (S.tile === 'approved' && !isApproved(row)) return false;
		if (S.tile === 'changes' && !d?.reviews.some((r) => r.state === 'CHANGES_REQUESTED')) return false;
		if (S.tile === 'bot' && !((d?.bot?.open ?? 0) > 0)) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Grouping (stacked PRs) and layout

function computeGroups(): Group[] {
	const live = [...rows.values()].filter((r) => !r.gone || r.leavingVisible);
	const byHead = new Map<string, Row>();
	const refKey = (r: Row, branch: string): string => `${r.light.host}:${r.light.owner}/${r.light.repo}@${branch}`;
	for (const r of live) byHead.set(refKey(r, r.light.headRefName), r);

	const parentOf = new Map<string, string>();
	for (const r of live) {
		let p: Row | null | undefined = DEFAULT_BRANCHES.has(r.light.baseRefName) ? null : byHead.get(refKey(r, r.light.baseRefName));
		if (!p && r.detail?.parent) p = rows.get(rowKeyOf(r.light.host, r.light.owner, r.light.repo, r.detail.parent.number));
		if (p && p !== r && live.includes(p)) parentOf.set(r.key, p.key);
	}
	// Break cycles defensively.
	for (const r of live) {
		const seen = new Set([r.key]);
		let k = parentOf.get(r.key);
		while (k) {
			if (seen.has(k)) {
				parentOf.delete(r.key);
				break;
			}
			seen.add(k);
			k = parentOf.get(k);
		}
	}
	const children = new Map<string, Row[]>();
	for (const [c, p] of parentOf) {
		let list = children.get(p);
		if (!list) children.set(p, (list = []));
		const child = rows.get(c);
		if (child) list.push(child);
	}
	const groups: Group[] = [];
	for (const r of live) {
		if (parentOf.has(r.key)) continue;
		const members: Row[] = [];
		const walk = (node: Row, depth: number): void => {
			node.depth = depth;
			node.parentKey = parentOf.get(node.key) || null;
			node.groupKey = r.key;
			members.push(node);
			for (const c of (children.get(node.key) || []).sort((a, b) => a.light.number - b.light.number)) walk(c, depth + 1);
		};
		walk(r, 0);
		const open = members.filter((m) => !m.gone);
		const approvedCount = open.filter(isApproved).length;
		groups.push({
			key: r.key,
			members,
			you: members.some(waitingOnMe),
			// A stack is ready only when all of it is; rows already leaving (merged) don't count.
			approved: open.length > 0 && approvedCount === open.length,
			partial: approvedCount > 0 && approvedCount < open.length,
			blocked: open.length > 0 && approvedCount === open.length && open.some(hasBlockers),
			updated: Math.max(...members.map((m) => new Date(m.light.updatedAt).getTime())),
		});
	}
	// Ready to land first (approved, no conflicts, no failed checks), then approved but blocked,
	// then what waits on you, then most recently updated.
	const band = (g: Group): number => (g.approved ? (g.blocked ? 1 : 2) : 0);
	groups.sort((a, b) => band(b) - band(a) || Number(b.you) - Number(a.you) || b.updated - a.updated);
	return groups;
}

let layoutPending = false;
function scheduleLayout(): void {
	if (layoutPending) return;
	layoutPending = true;
	requestAnimationFrame(() => {
		layoutPending = false;
		layout();
	});
}

function layout(): void {
	const container = $('#groups');
	const before = new Map<Element, number>();
	for (const el of container.children) before.set(el, el.getBoundingClientRect().top);

	const groups = computeGroups();
	lastGroups = groups;
	const wanted: HTMLDivElement[] = [];
	const usedKeys = new Set<string>();
	for (const g of groups) {
		// Approval chips filter whole groups (a stack is never split), like the repo chips: none selected shows all.
		if ((S.onlyApproved || S.onlyPartial) && !((S.onlyApproved && g.approved) || (S.onlyPartial && g.partial))) continue;
		if (!g.members.some((m) => matchesFilters(m) || m.leavingVisible)) continue;
		let gel = groupEls.get(g.key);
		if (!gel) {
			gel = document.createElement('div');
			gel.className = 'group';
			gel.dataset.key = g.key;
			groupEls.set(g.key, gel);
		}
		const groupEl = gel;
		g.members.forEach((m, i) => {
			if (groupEl.children[i] !== m.el.root) groupEl.insertBefore(m.el.root, groupEl.children[i] || null);
		});
		while (gel.children.length > g.members.length) gel.lastElementChild?.remove();
		gel.classList.toggle('you', g.you);
		gel.classList.toggle('approved', g.approved && !g.blocked);
		gel.classList.toggle('approved-blocked', g.blocked);
		usedKeys.add(g.key);
		wanted.push(gel);
	}
	wanted.forEach((gel, i) => {
		if (container.children[i] !== gel) container.insertBefore(gel, container.children[i] || null);
	});
	while (container.children.length > wanted.length) container.lastElementChild?.remove();
	for (const k of [...groupEls.keys()]) if (!usedKeys.has(k)) groupEls.delete(k);

	for (const r of rows.values()) renderRow(r);

	// FLIP: animate groups that moved.
	for (const el of wanted) {
		const prev = before.get(el);
		if (prev === undefined) continue;
		const dy = prev - el.getBoundingClientRect().top;
		if (Math.abs(dy) < 2) continue;
		el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
	}

	const empty = $('#empty');
	empty.hidden = wanted.length > 0;
	if (!wanted.length) {
		empty.innerHTML = lastList
			? `<i class="fa-regular fa-face-smile"></i>Nothing matches these filters.`
			: `<i class="fa-solid fa-spinner fa-spin"></i>Loading pull requests…`;
	}
	renderChrome();
}

// ---------------------------------------------------------------------------
// Header, tiles, filter chips

function renderChrome(): void {
	const scoped = [...rows.values()].filter((r) => matchesFilters(r, { ignoreTile: true }));
	const count = (fn: (r: Row) => unknown): number => scoped.filter((r) => fn(r)).length;
	const botOpen = scoped.reduce((n, r) => n + (r.detail?.bot?.open || 0), 0);
	const tiles: Tile[] = [
		{ id: 'me', cls: 'you', icon: 'fa-solid fa-hand-point-right', label: 'Waiting on you', value: count(waitingOnMe) },
		{ id: 'approved', cls: 'ok', icon: 'fa-solid fa-check', label: 'Approved', value: count(isApproved) },
		{ id: 'changes', cls: 'bad', icon: 'fa-solid fa-arrow-rotate-left', label: 'Changes requested', value: count((r) => r.detail?.reviews.some((x) => x.state === 'CHANGES_REQUESTED')) },
		{ id: 'bot', cls: 'bot', icon: 'fa-solid fa-robot', label: `${cfg.aiReviewLabel} open`, value: count((r) => (r.detail?.bot?.open ?? 0) > 0), note: botOpen ? `${botOpen} threads` : '' },
		{ id: null, cls: 'all', icon: 'fa-solid fa-code-pull-request', label: 'Open PRs', value: scoped.length },
	];
	const html = tiles
		.map(
			(t) => `<button class="tile ${t.cls}" data-tile="${t.id ?? ''}" aria-pressed="${S.tile === t.id && t.id !== null}">
				<div class="t-label"><i class="${t.icon}"></i>${t.label}</div>
				<div class="t-value">${t.value}${t.note ? `<span class="t-note">${t.note}</span>` : ''}</div>
			</button>`
		)
		.join('');
	const tilesEl = $('#tiles');
	if (tilesEl.innerHTML !== html) tilesEl.innerHTML = html;

	// People: filter by person; bell toggles "show PRs that request this person's review".
	const inScopeRows = [...rows.values()].filter(inScope);
	const people = cfg.team
		.map((m) => {
			const n = inScopeRows.filter((r) => member(r.light.author.login)?.id === m.id).length;
			const on = S.people.includes(m.id);
			const waiting = S.waitingOn.includes(m.id);
			const waitN = inScopeRows.filter((r) => waitingOnMember(r, m.id)).length;
			const bell = reviewers().includes(m.id);
			const who = m.id === cfg.me ? 'you' : m.short;
			return `<span class="person ${on ? 'on' : ''}">
				<button class="p-main" data-person="${m.id}" title="Show only pull requests ${m.id === cfg.me ? 'you' : esc(m.name)} wrote">${avatar(Object.values(m.logins)[0] ?? '', Object.keys(m.logins)[0] ?? '')}${esc(m.short)} <span class="count">${n}</span></button>
				<button class="p-wait ${waiting ? 'on' : ''}" data-wait="${m.id}" title="Show only pull requests waiting on ${esc(who)}'s review (${waitN})"><i class="fa-${waiting ? 'solid' : 'regular'} fa-hourglass-half"></i>${waitN ? `<span class="count">${waitN}</span>` : ''}</button>
				<button class="p-bell ${bell ? 'on' : ''}" data-bell="${m.id}" title="${bell ? 'Hide' : 'Include'} pull requests that request a review from ${esc(who)}"><i class="fa-${bell ? 'solid' : 'regular'} fa-bell"></i></button>
			</span>`;
		})
		.join('');
	const peopleEl = $('#people');
	if (peopleEl.innerHTML !== people) peopleEl.innerHTML = people;

	const repos = cfg.repos
		.map((r) => {
			const n = inScopeRows.filter((x) => x.light.host === r.host && x.light.repo === r.name && x.light.owner === r.owner).length;
			const on = S.repos.includes(r.short);
			const icon = hostIcon(r.host);
			return `<button class="chip-btn ${on ? 'on' : ''}" data-repo="${esc(r.short)}"><i class="${icon}"></i>${esc(r.short)} <span class="count">${n}</span></button>`;
		})
		.join('');
	const reposEl = $('#repos');
	if (reposEl.innerHTML !== repos) reposEl.innerHTML = repos;

	const dormantN = [...rows.values()].filter((r) => !r.gone && isDormant(r)).length;
	const draftN = [...rows.values()].filter((r) => !r.gone && r.light.isDraft).length;
	const scopedGroups = lastGroups.filter((g) => g.members.some(inScope));
	const approvedN = scopedGroups.filter((g) => g.approved).length;
	const partialN = scopedGroups.filter((g) => g.partial).length;
	// Approval chips filter like the repo chips: select any combination, or none for all.
	const approvals = `
		<button class="chip-btn ${S.onlyApproved ? 'on' : ''}" data-toggle="onlyApproved" title="Show only approved pull requests and fully approved stacks (combine with Partially approved)"><i class="fa-solid fa-check"></i>Approved <span class="count">${approvedN}</span></button>
		<button class="chip-btn ${S.onlyPartial ? 'on' : ''}" data-toggle="onlyPartial" title="Show only stacks where some pull requests are approved (combine with Approved)"><i class="fa-solid fa-list-check"></i>Partially approved <span class="count">${partialN}</span></button>`;
	const approvalsEl = $('#approvals');
	if (approvalsEl.innerHTML !== approvals) approvalsEl.innerHTML = approvals;
	const toggles = `
		<button class="chip-btn ${S.drafts ? 'on' : ''}" data-toggle="drafts" title="Show draft pull requests"><i class="fa-regular fa-file-lines"></i>Drafts <span class="count">${draftN}</span></button>
		<button class="chip-btn ${S.dormant ? 'on' : ''}" data-toggle="dormant" title="Show pull requests idle for 60+ days"><i class="fa-solid fa-moon"></i>Dormant 60d+ <span class="count">${dormantN}</span></button>`;
	const togglesEl = $('#toggles');
	if (togglesEl.innerHTML !== toggles) togglesEl.innerHTML = toggles;

	// Header bits
	// Show the budget of the first host that reports one (github.com does; most Enterprise servers don't).
	const rateHost = Object.keys(cfg.hosts).find((h) => rate[h]);
	const gh = rateHost ? rate[rateHost] : undefined;
	const rateEl = $('#rate');
	if (gh) {
		rateEl.innerHTML = `<i class="fa-solid fa-gauge-high"></i>${gh.remaining.toLocaleString()}/${gh.limit.toLocaleString()}`;
		rateEl.title = `${cfg.hosts[rateHost ?? '']?.hostname ?? 'GitHub'} GraphQL budget; resets ${new Date(gh.resetAt).toLocaleTimeString()}`;
		rateEl.classList.toggle('low', gh.remaining < 500);
	}
	const total = [...rows.values()].filter((r) => !r.gone).length;
	$('#brand-sub').textContent = lastList
		? `${total} open PRs across ${cfg.repos.length} repos · list checked ${new Date(lastList).toLocaleTimeString()}`
		: 'Loading…';

	const errs = Object.entries(hostErrors);
	const banner = $('#banner');
	banner.hidden = !errs.length;
	if (errs.length) {
		banner.innerHTML = `<i class="fa-solid fa-plug-circle-exclamation"></i><div>${errs
			.map(([h, m]) => `<strong>${esc(cfg.hosts[h]?.hostname || 'Dashboard server')}</strong> could not be reached; showing the last known data. <span class="mono">${esc(m.slice(0, 220))}</span>`)
			.join('<br>')}</div>`;
	}

	$('#theme').innerHTML = `<i class="fa-solid ${effectiveTheme() === 'dark' ? 'fa-sun' : 'fa-moon'}"></i>`;
}

// ---------------------------------------------------------------------------
// Fetching: list + per-row detail through a small parallel pool

const queue: Row[] = [];
let active = 0;

function maxAge(row: Row): number {
	// Hosts that report a GraphQL budget (github.com) get a slower floor than unmetered ones.
	const floor = rate[row.light.host] || isDotcom(row.light.host) ? 120_000 : 20_000;
	const hostRate = rate[row.light.host];
	const low = hostRate !== undefined && hostRate.remaining < 500;
	return low ? 600_000 : Math.max(S.interval, floor);
}

function enqueue(row: Row, { force = false, priority = false }: { force?: boolean; priority?: boolean } = {}): void {
	if (force) row.force = true;
	if (row.fetching || row.queued) return;
	row.queued = true;
	if (priority) queue.unshift(row);
	else queue.push(row);
	setCell(row, 'upd', cellUpdated(row), false);
	pump();
}

function pump(): void {
	while (active < MAX_PARALLEL && queue.length) {
		const row = queue.shift();
		if (!row) break;
		row.queued = false;
		if (!rows.has(row.key)) continue;
		active++;
		void fetchDetail(row).finally(() => {
			active--;
			pump();
		});
	}
}

async function fetchDetail(row: Row): Promise<void> {
	row.fetching = true;
	setCell(row, 'upd', cellUpdated(row), false);
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 60_000);
	const l = row.light;
	const params = new URLSearchParams({ host: l.host, owner: l.owner, repo: l.repo, number: String(l.number), head: l.headRefName, base: l.baseRefName });
	if (row.force) params.set('force', '1');
	row.force = false;
	try {
		const res = await fetch(`/api/pr?${params}`, { signal: ctrl.signal });
		const body: unknown = await res.json();
		if (res.status === 404) {
			removeRow(row);
			return;
		}
		if (!res.ok) throw new Error(responseError(body) || res.statusText);
		if (!isDetailResponse(body)) throw new Error('Unexpected response from /api/pr');
		const d = body.pr;
		if (body.rate) rate[l.host] = body.rate;
		const structural = !row.detail || row.detail.parent?.number !== d.parent?.number || l.baseRefName !== d.baseRefName || l.headRefName !== d.headRefName;
		row.detail = d;
		row.light = { ...l, title: d.title, isDraft: d.isDraft, updatedAt: d.updatedAt, headRefName: d.headRefName, baseRefName: d.baseRefName };
		row.lastFetch = Date.now();
		row.error = null;
		if (d.state === 'MERGED') markMerged(row);
		else if (d.state === 'CLOSED') removeRow(row);
		else if (row.missing >= 2) removeRow(row); // open, but no longer matches any search
		if (structural) scheduleLayout();
		else scheduleChrome();
	} catch (e) {
		row.error = errorName(e) === 'AbortError' ? 'timed out' : errorMessage(e);
	} finally {
		clearTimeout(timer);
		row.fetching = false;
		if (rows.has(row.key)) renderRow(row);
	}
}

let chromePending = false;
function scheduleChrome(): void {
	if (chromePending) return;
	chromePending = true;
	setTimeout(() => {
		chromePending = false;
		// Waiting-on-you and filter membership can change with detail data.
		scheduleLayout();
	}, 150);
}

function markMerged(row: Row): void {
	if (row.gone) return;
	row.gone = true;
	row.leavingVisible = true;
	renderRow(row);
	setTimeout(() => {
		const gel = row.el.root.parentElement;
		if (gel && gel.children.length === 1) gel.classList.add('leaving');
		else row.el.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 450, fill: 'forwards' });
		setTimeout(() => {
			row.leavingVisible = false;
			rows.delete(row.key);
			scheduleLayout();
		}, 500);
	}, 6000);
}

function removeRow(row: Row): void {
	if (row.gone) return;
	row.gone = true;
	row.leavingVisible = true;
	const gel = row.el.root.parentElement;
	if (gel && gel.children.length === 1) gel.classList.add('leaving');
	else row.el.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' });
	setTimeout(() => {
		row.leavingVisible = false;
		rows.delete(row.key);
		scheduleLayout();
	}, 450);
}

async function refreshList({ force = false }: { force?: boolean } = {}): Promise<void> {
	if (listBusy) return;
	listBusy = true;
	$('#refresh').classList.add('busy');
	try {
		const res = await fetch(`/api/prs?reviewers=${encodeURIComponent(reviewers().join(','))}`);
		const body: unknown = await res.json();
		const list = isListResponse(body) ? body : null;
		hostErrors = list?.errors || {};
		rate = { ...rate, ...(list?.rate || {}) };
		lastList = Date.now();
		if (!list) throw new Error(responseError(body) || 'Unexpected response from /api/prs');
		const seen = new Set<string>();
		for (const pr of list.prs) {
			seen.add(pr.key);
			let row = rows.get(pr.key);
			if (!row) {
				row = createRow(pr);
				rows.set(pr.key, row);
				renderRow(row);
				if (inScope(row)) enqueue(row, { priority: true });
				continue;
			}
			if (row.gone) continue;
			const changed = pr.updatedAt !== row.light.updatedAt;
			row.light = { ...row.light, ...pr, updatedAt: changed ? pr.updatedAt : row.light.updatedAt };
			row.missing = 0;
			if ((changed || force) && inScope(row)) enqueue(row, { force: true, priority: changed });
		}
		for (const row of rows.values()) {
			if (row.gone || seen.has(row.key) || hostErrors[row.light.host]) continue;
			const stillWanted = row.light.authoredByTeam || row.light.requestedFor.some((id) => reviewers().includes(id));
			if (!stillWanted) {
				removeRow(row); // a review-request toggle was switched off
				continue;
			}
			// Search is eventually consistent: verify directly before removing.
			row.missing++;
			enqueue(row, { force: true, priority: true });
		}
		const now = Date.now();
		for (const row of rows.values()) {
			if (!row.gone && inScope(row) && (!row.detail || now - row.lastFetch > maxAge(row))) enqueue(row);
		}
	} catch (e) {
		hostErrors = { server: errorMessage(e) };
	} finally {
		listBusy = false;
		$('#refresh').classList.remove('busy');
		scheduleLayout();
		void refreshHerdr();
	}
}

// ---------------------------------------------------------------------------
// herdr: link terminal panes to PRs (only when herdr is installed and running)

let herdrLinks: Record<string, PaneLink[]> = {};
let herdrBusy = false;

async function refreshHerdr(): Promise<void> {
	if (herdrBusy || !cfg) return;
	herdrBusy = true;
	try {
		const prs: PaneMatchPr[] = [...rows.values()]
			.filter((r) => !r.gone)
			.map(({ light: l }) => ({ key: l.key, host: l.host, owner: l.owner, repo: l.repo, number: l.number, url: l.url, headRefName: l.headRefName }));
		const res = await fetch('/api/herdr/links', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prs }) });
		const body: unknown = await res.json();
		const next = res.ok && isRecord(body) && body.available === true && isRecord(body.links) ? (body.links as Record<string, PaneLink[]>) : {};
		if (JSON.stringify(next) !== JSON.stringify(herdrLinks)) {
			herdrLinks = next;
			scheduleLayout();
		}
	} catch {
		/* herdr links are optional; keep the last ones */
	} finally {
		herdrBusy = false;
	}
}

const HERDR_SIGNAL_TEXT: Record<PaneSignal, { icon: string; text: string }> = {
	tag: { icon: 'fa-solid fa-tag', text: 'tagged with this PR' },
	transcript: { icon: 'fa-regular fa-comments', text: 'running an agent that has been discussing this PR' },
	branch: { icon: 'fa-solid fa-code-branch', text: "checked out on this PR's branch" },
};

function herdrChips(row: Row): string[] {
	const links = herdrLinks[row.key] ?? [];
	if (!links.length) return [];
	const chips = links.slice(0, 2).map((p) => {
		const status = p.agentStatus && p.agent ? p.agentStatus : 'shell';
		const where = p.workspaceLabel || p.workspaceId;
		const best = p.signals[0] ?? 'branch';
		const g = p.git;
		const gitBits = [
			g && g.dirty ? `<span class="hd-git" title="${g.dirty} uncommitted change${g.dirty === 1 ? '' : 's'}"><i class="fa-solid fa-pen"></i>${g.dirty}</span>` : '',
			g && g.unpushed ? `<span class="hd-git" title="${g.unpushed} unpushed commit${g.unpushed === 1 ? '' : 's'}"><i class="fa-solid fa-arrow-up"></i>${g.unpushed}</span>` : '',
		].join('');
		const changed = p.lastChangeAt ? `; changed ${relTime(new Date(p.lastChangeAt).toISOString())}` : '';
		const title = [
			`${p.title || where} (${p.agent ? `${p.agent} ${p.agentStatus ?? ''}`.trim() : 'shell'})`,
			`Linked because the pane is ${p.signals.map((s) => HERDR_SIGNAL_TEXT[s].text).join(', and ')}`,
			g ? `Branch ${g.branch}${g.worktree ? ' (worktree)' : ''}: ${g.dirty} uncommitted, ${g.unpushed ?? '?'} unpushed` : '',
			`Click to focus pane ${p.paneId} in herdr${changed}`,
		]
			.filter(Boolean)
			.join('\n');
		return `<button class="herdr-chip st-${esc(status)}" data-herdr-pane="${esc(p.paneId)}" title="${esc(title)}"><span class="hd-dot"></span><i class="fa-solid fa-terminal"></i>${esc(where)}<i class="hd-sig ${HERDR_SIGNAL_TEXT[best].icon}"></i>${gitBits}</button>`;
	});
	if (links.length > 2) {
		chips.push(`<span class="assoc" title="${esc(links.slice(2).map((p) => p.workspaceLabel || p.paneId).join(', '))}">+${links.length - 2} panes</span>`);
	}
	return chips;
}

async function focusHerdrPane(button: HTMLElement, paneId: string): Promise<void> {
	button.classList.remove('hd-ok', 'hd-fail');
	try {
		const res = await fetch('/api/herdr/focus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paneId }) });
		button.classList.add(res.ok ? 'hd-ok' : 'hd-fail');
		if (!res.ok) button.title = `Could not focus the pane: ${(await res.json().catch(() => ({ error: res.statusText }))).error}`;
	} catch (e) {
		button.classList.add('hd-fail');
		button.title = `Could not focus the pane: ${errorMessage(e)}`;
	}
	setTimeout(() => button.classList.remove('hd-ok', 'hd-fail'), 1500);
}

// ---------------------------------------------------------------------------
// Ticking

function schedule(): void {
	clearTimeout(tickTimer);
	tickTimer = setTimeout(tick, S.interval);
	const bar = $('#tick');
	bar.style.animation = 'none';
	void bar.offsetWidth;
	bar.style.animation = `tick ${S.interval}ms linear forwards`;
}

function tick(): void {
	schedule();
	if (document.hidden) return; // save the API budget while the tab is in the background
	void refreshList();
}

function refreshNow(): void {
	schedule();
	void refreshList({ force: true });
}

document.addEventListener('visibilitychange', () => {
	if (!document.hidden && lastList && Date.now() - lastList > S.interval) tick();
});

// ---------------------------------------------------------------------------
// Theme

function effectiveTheme(): Theme {
	return S.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function applyTheme(): void {
	if (S.theme) document.documentElement.dataset.theme = S.theme;
	else delete document.documentElement.dataset.theme;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => renderChrome());

// ---------------------------------------------------------------------------
// Popover for AI-review findings

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function openBotPopover(btn: HTMLElement, row: Row): void {
	const b = row.detail?.bot;
	if (!b) return;
	const pop = $('#popover');
	const items = [...b.findings]
		.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity])
		.map(
			(f: BotFinding) => `<a class="finding" href="${esc(f.url)}" target="_blank" rel="noopener">
				<div class="f-title">${esc(f.title)}</div>
				<div class="f-meta">
					<span class="sev-tag ${esc(f.severity)}">${esc(f.severity)}</span>
					<span class="sev-tag">${esc(f.kind)}</span>
					${f.outdated ? '<span class="sev-tag" title="The code changed since this comment">outdated</span>' : ''}
					${f.path ? `<span class="f-path">${esc(f.path.split('/').slice(-2).join('/'))}${f.line ? `:${f.line}` : ''}</span>` : ''}
				</div>
			</a>`
		)
		.join('');
	pop.innerHTML = `<h3><i class="fa-solid fa-robot"></i> ${b.open} unresolved ${esc(cfg.aiReviewLabel)} thread${b.open === 1 ? '' : 's'} · #${row.light.number}</h3>${items}`;
	pop.hidden = false;
	const r = btn.getBoundingClientRect();
	const w = pop.offsetWidth;
	const h = pop.offsetHeight;
	const left = Math.min(r.left, window.innerWidth - w - 16);
	let top = r.bottom + 6;
	if (top + h > window.innerHeight - 16) top = Math.max(16, r.top - h - 6);
	pop.style.left = `${Math.max(16, left)}px`;
	pop.style.top = `${top}px`;
	pop.dataset.key = row.key;
}
function closePopover(): void {
	$('#popover').hidden = true;
}

// ---------------------------------------------------------------------------
// Events

function toggleIn(list: string[], v: string): void {
	const i = list.indexOf(v);
	if (i === -1) list.push(v);
	else list.splice(i, 1);
}

document.addEventListener('click', (e) => {
	const target = e.target;
	if (!(target instanceof Element)) return;
	const hit = target.closest('button, a');
	const t = hit instanceof HTMLElement ? hit : null;
	if (!target.closest('#popover') && !target.closest('[data-bot]')) closePopover();
	if (!t) return;
	const ds = t.dataset;
	if (ds.bot) {
		const row = rows.get(ds.bot);
		const pop = $('#popover');
		if (!pop.hidden && pop.dataset.key === ds.bot) {
			closePopover();
			return;
		}
		if (row?.detail?.bot) openBotPopover(t, row);
		return;
	}
	if (ds.refresh) {
		const row = rows.get(ds.refresh);
		if (row) enqueue(row, { force: true, priority: true });
		return;
	}
	if (ds.herdrPane) {
		void focusHerdrPane(t, ds.herdrPane);
		return;
	}
	if ('tile' in ds) {
		const tile = ds.tile;
		S.tile = tile && isTileId(tile) && S.tile !== tile ? tile : null;
	} else if (ds.person) {
		toggleIn(S.people, ds.person);
	} else if (ds.wait) {
		toggleIn(S.waitingOn, ds.wait);
	} else if (ds.bell) {
		toggleIn((S.reviewers ??= []), ds.bell);
		save();
		void refreshList();
		return;
	} else if (ds.repo) {
		toggleIn(S.repos, ds.repo);
	} else if (ds.toggle === 'drafts' || ds.toggle === 'dormant' || ds.toggle === 'onlyApproved' || ds.toggle === 'onlyPartial') {
		S[ds.toggle] = !S[ds.toggle];
		// Newly in-scope rows (e.g. dormant ones) need their details.
		for (const row of rows.values()) if (inScope(row) && !row.detail) enqueue(row);
	} else return;
	save();
	scheduleLayout();
});

document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') closePopover();
	if (!(e.target instanceof Element) || e.target.matches('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
	if (e.key === 'r') refreshNow();
	if (e.key === '/') {
		e.preventDefault();
		$<HTMLInputElement>('#q').focus();
	}
});
window.addEventListener('scroll', closePopover, { passive: true });

$('#refresh').addEventListener('click', refreshNow);
$('#theme').addEventListener('click', () => {
	S.theme = effectiveTheme() === 'dark' ? 'light' : 'dark';
	applyTheme();
	save();
	renderChrome();
});
const qInput = $<HTMLInputElement>('#q');
qInput.value = S.q;
qInput.addEventListener('input', () => {
	S.q = qInput.value.trim();
	save();
	scheduleLayout();
});

function renderIntervals(): void {
	$('#interval').innerHTML = INTERVALS.map(
		(i) => `<button role="radio" aria-checked="${S.interval === i.ms}" data-interval="${i.ms}" title="Refresh every ${i.label}">${i.label}</button>`
	).join('');
}
$('#interval').addEventListener('click', (e) => {
	const target = e.target;
	if (!(target instanceof Element)) return;
	const b = target.closest('[data-interval]');
	if (!(b instanceof HTMLElement)) return;
	S.interval = Number(b.dataset.interval);
	save();
	renderIntervals();
	schedule();
});

// Keep relative times fresh without refetching.
setInterval(() => {
	for (const r of rows.values()) setCell(r, 'upd', cellUpdated(r), false);
}, 20_000);

// ---------------------------------------------------------------------------
// Boot

void (async function boot(): Promise<void> {
	applyTheme();
	const config: unknown = await (await fetch('/api/config')).json();
	if (!isPublicConfig(config)) throw new Error('Unexpected response from /api/config');
	cfg = config;
	for (const m of cfg.team) {
		for (const login of Object.values(m.logins)) memberByLogin.set(login.toLowerCase(), m);
	}
	$('#ai-review-label').textContent = cfg.aiReviewLabel;
	if (!Array.isArray(S.reviewers)) S.reviewers = [cfg.me];
	if (!INTERVALS.some((i) => i.ms === S.interval)) S.interval = 60_000;
	renderIntervals();
	layout();
	schedule();
	await refreshList();
})();
