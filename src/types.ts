// Shared types for the Shepherd server, its MCP endpoint and the browser client.

// ---------------------------------------------------------------------------
// Config (config.json)

export interface TeamMember {
	id: string;
	name: string;
	/** Label shown on screen. */
	short: string;
	/** Login per host, keyed by a key of `Config.hosts` (e.g. { "github": "octocat" }). */
	logins: Record<string, string>;
}

export interface HostConfig {
	hostname: string;
	label: string;
	/** Path to a proxychains config, for hosts reachable only through a SOCKS proxy. */
	proxychains?: string;
	/** Cap on parallel `gh` processes for this host. */
	concurrency?: number;
	/** Login of an AI code-review bot on this host whose unresolved threads are counted, or null. */
	bot: string | null;
}

export interface RepoConfig {
	/** A key of `Config.hosts`. */
	host: string;
	owner: string;
	name: string;
	short: string;
	/** Optional: flag open PRs whose merge base with the base branch is older than this many hours. */
	maxBaseAgeHours?: number;
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
}

/** What GET /api/config returns: the config without local-only details. */
export interface PublicConfig {
	me: string;
	team: TeamMember[];
	repos: RepoConfig[];
	hosts: Record<string, Pick<HostConfig, 'hostname' | 'label' | 'bot'>>;
	linear: LinearConfig | null;
	aiReviewLabel: string;
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
	author: PrAuthor;
	authoredByTeam: boolean;
	/** Team member ids whose direct review request matched this PR. */
	requestedFor: string[];
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
	author: PrAuthor;
	mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
	reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
	/** statusCheckRollup state, e.g. SUCCESS, FAILURE, PENDING; null when there are no checks. */
	checks: string | null;
	size: { additions: number; deletions: number; files: number };
	requested: { users: { login: string; name: string | null }[]; teams: { slug: string; name: string }[] };
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

// ---------------------------------------------------------------------------
// HTTP API responses

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
