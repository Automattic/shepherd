// Shared types for the Shepherd server, its MCP endpoint and the browser client.

import type { Feature, Features } from './features.ts';

// ---------------------------------------------------------------------------
// Config (config.json)

export interface TeamMember {
	id: string;
	name: string;
	/** Label shown on screen. */
	short: string;
	/** Login per host, keyed by a key of `Config.hosts` (e.g. { "github": "octocat" }). */
	logins: Record<string, string>;
	/** Optional: how this person wants to receive changes on PRs they wrote (see docs/push-policy.md). */
	pushPolicy?: PushPolicy;
}

/**
 * How a PR's author wants to receive changes from reviewers and their agents: comments only, a separate PR
 * against their branch, or commits pushed to their branch.
 */
export type PushPolicy = 'review-only' | 'stacked-pr' | 'push';

export interface HostConfig {
	hostname: string;
	label: string;
	/** Path to a proxychains config, for hosts reachable only through a SOCKS proxy. */
	proxychains?: string;
	/** Cap on parallel `gh` processes for this host. */
	concurrency?: number;
	/** Login of an AI code-review bot on this host whose unresolved threads are counted, or null. The default for every owner. */
	bot: string | null;
	/**
	 * Optional: the AI-review bot of the repos of one owner (an org or a user) on this host, by owner login: a bot login,
	 * or null for none. It wins over `bot`, so the orgs on one host can each have their own bot.
	 */
	botsByOwner?: Record<string, string | null>;
	/**
	 * Optional: GitHub teams ("org/team") on this host that the people in `team` review for.
	 * A PR that requests one of them waits on every team member with a login here, except its author.
	 */
	reviewTeams?: string[];
	/**
	 * Optional: find the team's PRs in any repo of these orgs (or users) on this host, plus the listed repos. Without this
	 * key, the host searches only the listed repos, or `defaultOrgs` when it has none.
	 */
	anyRepo?: AnyRepoScope;
	/**
	 * Optional, set in config.json: the orgs that a host with no listed repos and no `anyRepo` searches. Without it, such
	 * a host is not searched. The settings panel also fills these in when someone turns "Any repo" on.
	 */
	defaultOrgs?: string[];
	/**
	 * Optional: the shortest time (ms) before the page loads a row on this host again.
	 * Defaults to 2 minutes on github.com and on hosts that report a GraphQL budget, and 20 seconds on other hosts.
	 */
	rowRefreshFloorMs?: number;
	/** Optional: the time (ms) between row loads on this host when its GraphQL budget is low. Defaults to 10 minutes. */
	rowRefreshLowBudgetMs?: number;
}

/** See `HostConfig.anyRepo`. `orgs` has at least one org: there is no "every repo on the host". */
export interface AnyRepoScope {
	orgs: string[];
}

export interface RepoConfig {
	/** A key of `Config.hosts`. */
	host: string;
	owner: string;
	name: string;
	short: string;
	/** Optional: flag open PRs whose merge base with the base branch is older than this many hours. */
	maxBaseAgeHours?: number;
	/** Optional: list every open PR in this repo, including PRs by people outside `team`. */
	allAuthors?: boolean;
	/** Optional: the push policy for PRs in this repo. Combined with the author's, the stricter one wins. */
	pushPolicy?: PushPolicy;
	/** Optional: per-author policies in this repo, keyed by team id or login. They win over every other setting. */
	pushPolicyByAuthor?: Record<string, PushPolicy>;
}

export interface LinearConfig {
	workspace: string;
	keys: string[];
}

export interface Config {
	port?: number;
	me: string;
	team: TeamMember[];
	hosts: Record<string, HostConfig>;
	repos: RepoConfig[];
	/** Optional: link Linear tickets found in titles, branches and descriptions. */
	linear?: LinearConfig | null;
	/** Name shown for the AI-review column and tile. Defaults to "AI review". */
	aiReviewLabel?: string;
	/** Optional herdr integration; on by default whenever herdr is installed and running. */
	herdr?: { enabled?: boolean; transcriptTailKb?: number };
	ignoreParticipants?: string[];
	/** Optional: dashboard features to turn off. A missing key means on. */
	features?: Partial<Features>;
	/**
	 * Optional: when the page loads a row again. "rows" (the default) also loads rows that are older than
	 * the refresh floor, and Refresh now loads every row. "list" loads a row only when the list shows a new
	 * `updatedAt` for it, or when the user asks for that row.
	 */
	refresh?: RefreshMode;
	/** Optional: cost limits that the server enforces (see docs/configuration.md). */
	limits?: SettingsLimits;
}

export type RefreshMode = 'rows' | 'list';

/**
 * The version of the JSON shapes in this file that the server sends and the client reads.
 * Increase it when a change here breaks an old client or an old server. See CONTRIBUTING.md.
 */
export const API_VERSION = 2;

/** What GET /api/config returns: the config without local-only details. */
export interface PublicConfig {
	/** The `API_VERSION` of the server. The client stops when it is not the client's own `API_VERSION`. */
	apiVersion: number;
	me: string;
	team: TeamMember[];
	/** Empty when the server has no fixed list of repos. The page then makes the repo chips from the listed PRs. */
	repos: RepoConfig[];
	/** `anyRepo`: the host finds PRs outside `repos` too, so the page adds chips for the repos of the listed rows. */
	hosts: Record<string, Pick<HostConfig, 'hostname' | 'label' | 'bot' | 'botsByOwner' | 'rowRefreshFloorMs' | 'rowRefreshLowBudgetMs' | 'anyRepo'>>;
	linear: LinearConfig | null;
	aiReviewLabel: string;
	/**
	 * Dashboard features the server supports. A missing object or a missing key means on, so a
	 * server that has only the open-PR endpoints sets the others to false.
	 */
	features?: Partial<Features>;
	/** A missing value means "rows". */
	refresh?: RefreshMode;
	/** Whose dashboard this is. See `ViewMode`. */
	mode: ViewMode;
	/** In a team or member view: the name of that team or person, for the page to show. */
	viewLabel?: string;
	/** In a team or member view: a link to the viewer's own dashboard. */
	personalUrl?: string;
}

/**
 * `personal`: the viewer's own dashboard, built from their personal settings.
 * `team` and `member`: a dashboard that the host defines for a team or one person. The viewer's personal
 * settings do not apply there, so the page does not edit them. The local server always sends `personal`.
 */
export type ViewMode = 'personal' | 'team' | 'member';

// ---------------------------------------------------------------------------
// Settings (GET and PUT /api/settings). See docs/configuration.md and docs/embedding.md.

/** The settings that each viewer owns and edits. */
export interface PersonalSettings {
	/** The team id of the viewer. */
	me: string;
	team: TeamMember[];
	/** Can be empty: a host with no listed repos finds PRs in any repo (or, on another host, by author). */
	repos: RepoConfig[];
	/** "org/team" names per host key; see `HostConfig.reviewTeams`. config.json keeps them under `hosts`. */
	reviewTeams: Record<string, string[]>;
	/**
	 * Optional: the hosts that find PRs in any repo, by host key; see `HostConfig.anyRepo`. config.json keeps them under
	 * `hosts`. A PUT that leaves it out keeps the current value, so an older client never turns it off.
	 */
	anyRepo?: Record<string, AnyRepoScope>;
	linear: LinearConfig | null;
	/** Features to turn off. A host marks a feature that it does not have as not editable. */
	features: Partial<Record<Feature, boolean>>;
}

/** The settings of the server. The page shows them; a host marks them not editable. */
export interface DeploymentSettings {
	/** `proxied`: the host goes through proxychains (set in config.json; the path is never sent). */
	hosts: Record<string, Pick<HostConfig, 'hostname' | 'label' | 'bot' | 'botsByOwner' | 'concurrency' | 'rowRefreshFloorMs' | 'rowRefreshLowBudgetMs' | 'defaultOrgs'> & { proxied?: boolean }>;
	refresh: RefreshMode;
	aiReviewLabel: string;
	ignoreParticipants: string[];
	limits: SettingsLimits;
}

/** Cost limits. Only the server enforces them; the page shows them. A missing value means no limit. */
export interface SettingsLimits {
	/** The most people in `team`. */
	maxPeople?: number;
	/** The most entries in `repos`. */
	maxRepos?: number;
	/** The most people whose review requests the list includes (bells) in one request. */
	maxBells?: number;
	/** The most API requests one viewer can make in `perSeconds` seconds. */
	requestBudget?: { requests: number; perSeconds: number };
}

/** The document that the settings schema (dist/settings.schema.json) describes. */
export interface SettingsDocument {
	personal: PersonalSettings;
	deployment: DeploymentSettings;
}

/** Whether the viewer can change a setting, and why not. */
export interface FieldMeta {
	editable: boolean;
	reason?: string;
}

/** What GET /api/settings returns, and PUT /api/settings after a save. */
export interface SettingsResponse extends SettingsDocument {
	/** Changes on each save. Send it back with PUT, so a save from an older copy is refused. */
	version: string;
	mode: ViewMode;
	/**
	 * Per-field metadata, keyed by JSON pointer into this document, for example `/personal/team` or
	 * `/personal/features/herdr`. A pointer segment `*` matches any item. The longest matching pointer wins.
	 */
	fields: Record<string, FieldMeta>;
	/** Problems in the stored settings that the server found after it started. It keeps using the last good settings. */
	problems?: string[];
}

/** The body of PUT /api/settings. */
export interface SettingsPutRequest {
	/** The `version` of the settings that the edit started from. */
	version: string;
	/** Every personal setting, all six keys. */
	personal: PersonalSettings;
	/** Only where `fields` makes a host field editable: the hosts, of which a request sets `hostname`, `label`, `bot` and `botsByOwner`. */
	deployment?: { hosts: DeploymentSettings['hosts'] };
}

/**
 * Why a field was refused:
 * - `invalid`: the value breaks the settings schema.
 * - `not_editable`: the field is not editable for this viewer.
 * - `limit`: the value is over a cost limit.
 * - `refused`: the host refuses the value, for example a repo the viewer may not watch.
 */
export type SettingsErrorCode = 'invalid' | 'not_editable' | 'limit' | 'refused';

export interface SettingsFieldError {
	/** A JSON pointer into the PUT body, for example `/personal/repos/2`. */
	path: string;
	code: SettingsErrorCode;
	message: string;
}

/**
 * The body of a refused PUT. 400: the body is not a settings request. 409: `version` is not the current
 * version (another tab or the file changed); `settings` has the current ones. 422: see `errors`.
 */
export interface SettingsErrorResponse {
	error: string;
	errors: SettingsFieldError[];
	settings?: SettingsResponse;
}

// ---------------------------------------------------------------------------
// Pull requests

export interface RateLimit {
	remaining: number;
	limit: number;
	resetAt: string;
	cost?: number;
	/** When the server recorded it (ms since epoch). */
	at: number;
}

export interface PrAuthor {
	login: string;
	name: string | null;
}

/** The light record from the list search. */
export interface LightPr {
	key: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	isDraft: boolean;
	updatedAt: string;
	createdAt: string;
	headRefName: string;
	baseRefName: string;
	/** The fork owner's login when the head branch is in another repo; null when it is in this repo. */
	fork: string | null;
	author: PrAuthor;
	authoredByTeam: boolean;
	/** The PR is in a repo with `allAuthors`, so it is listed whoever wrote it. */
	inAllAuthorsRepo: boolean;
	/** Team member ids whose direct review request matched this PR. */
	requestedFor: string[];
	/** The PR requests a review from one of the host's `reviewTeams`. */
	teamRequested: boolean;
	/**
	 * The details the server already has for this `updatedAt`, if any. The page shows them at once,
	 * and calls /api/pr for the row only when they are older than the row's refresh interval.
	 */
	detail?: PrDetail;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface BotFinding {
	title: string;
	severity: Severity;
	/** e.g. "fix here", "follow-up", "nit". */
	kind: string;
	category: string | null;
	belowThreshold: boolean;
	outdated: boolean;
	url: string;
	path: string | null;
	line: number | null;
	createdAt: string;
}

export interface BotSummary {
	login: string;
	open: number;
	/** Medium or higher, not nits, not below the reporting threshold. */
	blocking: number;
	outdated: number;
	bySeverity: Record<Severity, number>;
	findings: BotFinding[];
}

export interface MiniPr {
	number: number;
	title: string;
	url: string;
	author: string;
}

export interface Participant {
	login: string;
	name: string | null;
	lastActive: string | null;
}

export interface LastActivity {
	login: string;
	at: string;
	kind: 'comment' | 'review' | 'commit';
}

export interface PrRef {
	key: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
	url: string;
}

export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface PrReview {
	login: string;
	state: ReviewState;
	submittedAt: string | null;
}

/** How old the commit a PR branched from is. */
export interface BaseAge {
	/** The branch the merge base is measured against: the PR's base, or the default branch for a stacked PR. */
	against: string;
	/** Committer date of the merge base. Null when the compare call failed, which means unknown, not fresh. */
	mergeBaseAt: string | null;
	/** Commits on `against` that the PR branch doesn't have yet. */
	behindBy: number | null;
	/** The repo's `maxBaseAgeHours`, or null when it has none. */
	limitHours: number | null;
	error?: string;
}

/** The full record for one PR. */
export interface PrDetail {
	key: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	state: PrState;
	mergedAt: string | null;
	isDraft: boolean;
	updatedAt: string;
	createdAt: string;
	headRefName: string;
	baseRefName: string;
	/** The fork owner's login when the head branch is in another repo; null when it is in this repo. */
	fork: string | null;
	author: PrAuthor;
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
	reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
	/** statusCheckRollup state, e.g. SUCCESS, FAILURE, PENDING; null when there are no checks. */
	checks: string | null;
	size: { additions: number; deletions: number; files: number };
	/** `combinedSlug` is "org/team"; `reviewTeam`: the team is one of the host's `reviewTeams`. */
	requested: {
		users: { login: string; name: string | null }[];
		teams: { slug: string; combinedSlug: string; name: string; reviewTeam: boolean }[];
	};
	/** Latest opinionated review per reviewer. */
	reviews: PrReview[];
	/** Null on hosts without an AI-review bot. */
	bot: BotSummary | null;
	/** Everyone who commented, reviewed or committed, except the author and bots, most recently active first. */
	participants: Participant[];
	authorLastActive: string | null;
	/** The most recent human activity on the PR, including the author's comments and pushes. */
	lastActivity: LastActivity | null;
	/** When the newest commit was made, by anyone. */
	lastCommitAt: string | null;
	linear: string[];
	refs: PrRef[];
	hashRefs: number[];
	parent: MiniPr | null;
	stackedOnThis: MiniPr[];
	/** Null for merged and closed PRs. */
	baseAge: BaseAge | null;
	fetchedAt: string;
	throttled?: boolean;
}

/** A merged PR written by someone on the team. */
export interface MergedPr {
	key: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
	title: string;
	url: string;
	/** The author's login on this host. */
	author: string;
	/** Null only when GitHub returns a closed PR that never merged; those are dropped. */
	mergedAt: string | null;
}

/** Where a follow-up was written. */
export type FollowUpSource = 'description' | 'review' | 'comment' | 'inline';

/** A non-blocking ask left on a PR, such as an item under "Optional:" or a line that says "in a follow-up". */
export interface FollowUp {
	/** Login of whoever wrote it. */
	author: string;
	source: FollowUpSource;
	/** File and line, for inline comments. */
	path: string | null;
	line: number | null;
	text: string;
	url: string;
	at: string | null;
	/**
	 * The code changed after it was written (a later commit, or an outdated inline thread), so it may be done
	 * already. Such a follow-up is listed but not counted, since a wrong flag costs more than a missed one.
	 */
	stale: boolean;
}

// ---------------------------------------------------------------------------
// HTTP API responses

/** Follow-ups per PR key; a PR whose fetch failed is in `errors` instead. */
export interface FollowUpsResponse {
	followUps: Record<string, FollowUp[]>;
	errors: Record<string, string>;
}

export interface MergedResponse {
	prs: MergedPr[];
	errors: Record<string, string>;
}

export interface ListResponse {
	prs: LightPr[];
	errors: Record<string, string>;
	throttled: Record<string, boolean>;
	rate: Record<string, RateLimit>;
	fetchedAt: string;
}

export interface DetailResponse {
	pr: PrDetail;
	rate: RateLimit | null;
}

// ---------------------------------------------------------------------------
// herdr (terminal workspace manager) pane links

/** How a pane was tied to a PR, strongest first. */
export type PaneSignal = 'tag' | 'transcript' | 'branch';

/** What the client sends to match panes against. */
export interface PaneMatchPr {
	key: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
	url: string;
	headRefName: string;
}

export interface PaneLink {
	paneId: string;
	workspaceId: string;
	tabId: string;
	workspaceLabel: string | null;
	tabLabel: string | null;
	title: string | null;
	agent: string | null;
	/** herdr's agent state: idle, working, blocked, done or unknown. */
	agentStatus: string | null;
	signals: PaneSignal[];
	/** Git state of the pane's checkout, when it is in a repo. */
	git: { branch: string; dirty: number; unpushed: number | null; worktree: boolean } | null;
	/** When Shepherd last saw the pane change (ms since epoch), if it has. */
	lastChangeAt: number | null;
	focused: boolean;
}

export interface HerdrLinksResponse {
	available: boolean;
	/** Why herdr links are unavailable (not installed, not running, turned off). */
	reason?: string;
	links: Record<string, PaneLink[]>;
	scannedAt: string;
}

export interface ErrorResponse {
	error: string;
}
