// Links herdr terminal panes to pull requests, and focuses a pane on request.
//
// Only active when herdr is installed and its server is running (macOS or Linux). A pane is linked
// to a PR by, strongest first:
//   tag:        the pane carries a `pr` token (herdr pane report-metadata --token pr=<url or repo#n>)
//   transcript: the pane's agent transcript mentions the PR's URL, repo#number or branch recently
//   branch:     the pane's checkout is the PR's repo, on the PR's branch (and only one tracked PR uses it)
// Uncommitted changes, unpushed commits, agent state and recent pane changes label and sort links.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, HerdrLinksResponse, PaneLink, PaneMatchPr, PaneSignal } from './types.ts';

const SCAN_TTL_MS = 5_000;
const GIT_TTL_MS = 10_000;
const AVAILABILITY_TTL_MS = 30_000;
const DEFAULT_BRANCHES = new Set(['trunk', 'main', 'master', 'develop']);
const MIN_BRANCH_NEEDLE = 6; // shorter branch names are too generic to search transcripts for
const MAX_FOCUSED_PRS = 4; // a session mentioning more tracked PRs than this is surveying, not working
const DOMINANT_SHARE = 0.4; // ...unless one PR has at least this share of its mentions

// ---------------------------------------------------------------------------
// Snapshot shapes (subset of herdr's session.snapshot)

interface HerdrPane {
	pane_id: string;
	workspace_id: string;
	tab_id: string;
	cwd: string | null;
	foreground_cwd: string | null;
	focused: boolean;
	agent: string | null;
	agent_status: string | null;
	agent_session: { agent: string; kind: string; value: string } | null;
	terminal_title_stripped: string | null;
	tokens: Record<string, string> | null;
	revision: number | null;
	state_change_seq: number | null;
}

interface HerdrSnapshot {
	panes: HerdrPane[];
	workspaces: { workspace_id: string; label: string | null }[];
	tabs: { tab_id: string; label: string | null }[];
}

interface GitState {
	host: string;
	owner: string;
	repo: string;
	branch: string;
	dirty: number;
	unpushed: number | null;
	worktree: boolean;
}

// ---------------------------------------------------------------------------
// Process and socket helpers

async function run(cmd: string[], timeoutMs = 5_000): Promise<string | null> {
	try {
		const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
		const timer = setTimeout(() => proc.kill(), timeoutMs);
		const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		clearTimeout(timer);
		return code === 0 ? out : null;
	} catch {
		return null;
	}
}

/** Sends one request over herdr's socket (newline-delimited JSON) and returns its result. */
function request<T>(socketPath: string, method: string, params: Record<string, unknown> = {}, timeoutMs = 4_000): Promise<T> {
	const id = `shepherd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return new Promise<T>((resolve, reject) => {
		let buf = '';
		let settled = false;
		const decoder = new TextDecoder();
		const parse = (line: string) => {
			try {
				const msg = JSON.parse(line) as { result?: T; error?: { message: string } };
				if (msg.error) reject(new Error(msg.error.message));
				else resolve(msg.result as T);
			} catch (e) {
				reject(e as Error);
			}
		};
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn();
		};
		const timer = setTimeout(() => finish(() => reject(new Error(`herdr ${method} timed out`))), timeoutMs);
		Bun.connect({
			unix: socketPath,
			socket: {
				open(s) {
					s.write(JSON.stringify({ id, method, params }) + '\n');
				},
				data(s, chunk) {
					buf += decoder.decode(chunk, { stream: true });
					const nl = buf.indexOf('\n');
					if (nl === -1) return;
					s.end();
					finish(() => parse(buf.slice(0, nl)));
				},
				error(_s, e) {
					finish(() => reject(e));
				},
				// Large replies may end with the connection closing rather than a newline.
				close() {
					finish(() => (buf.trim() ? parse(buf.trim()) : reject(new Error(`herdr closed the connection during ${method}`))));
				},
			},
		}).catch((e: Error) => finish(() => reject(e)));
	});
}

// ---------------------------------------------------------------------------
// Parsing helpers

/** Splits a git remote URL into host, owner and repo (SSH or HTTPS). */
export function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
	const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
	return m ? { host: m[1]!.toLowerCase(), owner: m[2]!, repo: m[3]! } : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------

export interface HerdrService {
	links(prs: PaneMatchPr[]): Promise<HerdrLinksResponse>;
	focus(paneId: string): Promise<void>;
}

export function createHerdr(config: Config): HerdrService {
	const enabled = config.herdr?.enabled !== false;
	const tailBytes = Math.max(32, config.herdr?.transcriptTailKb ?? 192) * 1024;
	const hostKeyByHostname = new Map(Object.entries(config.hosts).map(([k, h]) => [h.hostname.toLowerCase(), k]));
	const shortName = (owner: string, repo: string) => config.repos.find((r) => r.owner === owner && r.name === repo)?.short ?? repo;

	// ---- availability: installed (binary on PATH) and running (server status) ----

	let availability: { at: number; socket: string | null; reason?: string } | null = null;

	async function socketPath(): Promise<{ socket: string | null; reason?: string }> {
		if (!enabled) return { socket: null, reason: 'turned off in config.json' };
		if (availability && Date.now() - availability.at < AVAILABILITY_TTL_MS) return availability;
		let result: { socket: string | null; reason?: string };
		const bin = Bun.which('herdr');
		if (!bin) {
			result = { socket: null, reason: 'herdr is not installed' };
		} else {
			const status = await run([bin, 'status', 'server']);
			if (!status || !/status:\s*running/i.test(status)) {
				result = { socket: null, reason: 'herdr is not running' };
			} else {
				const fromStatus = status.match(/socket:\s*(\S+)/i)?.[1];
				const socket = fromStatus || process.env.HERDR_SOCKET_PATH || join(homedir(), '.config', 'herdr', 'herdr.sock');
				result = (await Bun.file(socket).exists()) || fromStatus ? { socket } : { socket: null, reason: `herdr socket not found at ${socket}` };
			}
		}
		availability = { at: Date.now(), ...result };
		return result;
	}

	// ---- git state per directory ----

	const gitCache = new Map<string, { at: number; value: GitState | null }>();

	async function gitState(dir: string): Promise<GitState | null> {
		const cached = gitCache.get(dir);
		if (cached && Date.now() - cached.at < GIT_TTL_MS) return cached.value;
		const g = (...args: string[]) => run(['git', '-C', dir, ...args]);
		const [revs, remote, status, ahead] = await Promise.all([
			g('rev-parse', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'),
			g('remote', 'get-url', 'origin'),
			g('status', '--porcelain'),
			g('rev-list', '--count', '@{upstream}..HEAD'),
		]);
		let value: GitState | null = null;
		const parsed = remote ? parseRemote(remote) : null;
		const lines = revs?.trim().split('\n') ?? [];
		if (parsed && lines.length >= 3) {
			const [gitDir, commonDir, branch] = lines as [string, string, string];
			value = {
				...parsed,
				branch,
				dirty: status ? status.split('\n').filter(Boolean).length : 0,
				unpushed: ahead === null ? null : Number(ahead.trim()),
				worktree: gitDir !== commonDir,
			};
		}
		gitCache.set(dir, { at: Date.now(), value });
		return value;
	}

	// ---- agent transcripts ----

	const transcriptPathCache = new Map<string, string | null>();

	async function findTranscript(session: NonNullable<HerdrPane['agent_session']>): Promise<string | null> {
		if (session.kind === 'path') return session.value;
		const key = `${session.agent}:${session.value}`;
		if (transcriptPathCache.has(key)) return transcriptPathCache.get(key) ?? null;
		const id = session.value.replace(/[^\w-]/g, '');
		let found: string | null = null;
		const roots: [string, string][] = [];
		if (session.agent === 'claude') roots.push([join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'), `*/${id}.jsonl`]);
		if (session.agent === 'codex') roots.push([join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'), `**/*${id}*.jsonl`]);
		for (const [root, pattern] of roots) {
			try {
				for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true })) {
					found = join(root, rel);
					break;
				}
			} catch {
				/* root missing */
			}
			if (found) break;
		}
		if (found) transcriptPathCache.set(key, found); // only cache hits: a new session's file may appear later
		return found;
	}

	async function transcriptTail(path: string): Promise<string | null> {
		try {
			const f = Bun.file(path);
			const size = f.size;
			return await f.slice(Math.max(0, size - tailBytes), size).text();
		} catch {
			return null;
		}
	}

	// ---- scan ----

	interface ScannedPane {
		pane: HerdrPane;
		workspaceLabel: string | null;
		tabLabel: string | null;
		git: GitState | null;
		transcript: string | null;
		lastChangeAt: number | null;
	}

	const lastSeen = new Map<string, { sig: string; changedAt: number | null }>();
	let scanCache: { at: number; panes: ScannedPane[] } | null = null;
	let scanInflight: Promise<ScannedPane[]> | null = null;

	async function scan(socket: string): Promise<ScannedPane[]> {
		if (scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.panes;
		if (scanInflight) return scanInflight;
		scanInflight = (async () => {
			const { snapshot } = await request<{ snapshot: HerdrSnapshot }>(socket, 'session.snapshot');
			const wsLabel = new Map(snapshot.workspaces.map((w) => [w.workspace_id, w.label]));
			const tabLabel = new Map(snapshot.tabs.map((t) => [t.tab_id, t.label]));
			const dirs = [...new Set(snapshot.panes.map((p) => p.foreground_cwd || p.cwd).filter((d): d is string => !!d))];
			const gitByDir = new Map(await Promise.all(dirs.map(async (d) => [d, await gitState(d)] as const)));
			const now = Date.now();
			const panes = await Promise.all(
				snapshot.panes.map(async (pane): Promise<ScannedPane> => {
					// Activity: remember when the pane's revision or state counter last moved.
					const sig = `${pane.revision ?? ''}/${pane.state_change_seq ?? ''}/${pane.agent_status ?? ''}`;
					const prev = lastSeen.get(pane.pane_id);
					const changedAt = prev ? (prev.sig === sig ? prev.changedAt : now) : null;
					lastSeen.set(pane.pane_id, { sig, changedAt });
					const path = pane.agent_session ? await findTranscript(pane.agent_session) : null;
					return {
						pane,
						workspaceLabel: wsLabel.get(pane.workspace_id) ?? null,
						tabLabel: tabLabel.get(pane.tab_id) ?? null,
						git: gitByDir.get(pane.foreground_cwd || pane.cwd || '') ?? null,
						transcript: path ? await transcriptTail(path) : null,
						lastChangeAt: changedAt,
					};
				})
			);
			scanCache = { at: Date.now(), panes };
			return panes;
		})().finally(() => {
			scanInflight = null;
		});
		return scanInflight;
	}

	// ---- matching ----

	function prRefsFromTag(value: string, prs: PaneMatchPr[]): Set<string> {
		const keys = new Set<string>();
		for (const raw of value.split(/[\s,]+/).filter(Boolean)) {
			const v = raw.toLowerCase().replace(/^https?:\/\//, '');
			for (const pr of prs) {
				const hostname = config.hosts[pr.host]?.hostname.toLowerCase() ?? '';
				const forms = [
					`${hostname}/${pr.owner}/${pr.repo}/pull/${pr.number}`,
					`${pr.owner}/${pr.repo}#${pr.number}`,
					`${pr.repo}#${pr.number}`,
					`${shortName(pr.owner, pr.repo)}#${pr.number}`,
				].map((f) => f.toLowerCase());
				if (forms.includes(v)) keys.add(pr.key);
			}
		}
		return keys;
	}

	/** How many times the transcript text mentions this PR (URL, owner/repo#n, repo#n or a unique branch). */
	function transcriptMentions(text: string, pr: PaneMatchPr, branchUnique: boolean): number {
		const hostname = config.hosts[pr.host]?.hostname ?? '';
		const n = pr.number;
		const patterns = [
			`${escapeRe(hostname)}/${escapeRe(pr.owner)}/${escapeRe(pr.repo)}/pull/${n}(?!\\d)`,
			`${escapeRe(pr.owner)}/${escapeRe(pr.repo)}#${n}(?!\\d)`,
			`(?<![\\w/-])${escapeRe(pr.repo)}#${n}(?!\\d)`,
		];
		if (branchUnique && pr.headRefName.length >= MIN_BRANCH_NEEDLE && !DEFAULT_BRANCHES.has(pr.headRefName)) {
			patterns.push(`(?<![\\w/.-])${escapeRe(pr.headRefName)}(?![\\w/.-])`);
		}
		return text.match(new RegExp(patterns.join('|'), 'gi'))?.length ?? 0;
	}

	/**
	 * A session that works on a PR keeps returning to a few PRs; one that surveys PRs (dashboards,
	 * review queues) mentions many about equally. Link only focused sessions, or a PR that dominates.
	 */
	function focusedMentions(counts: Map<string, number>): Set<string> {
		const total = [...counts.values()].reduce((a, b) => a + b, 0);
		if (!total) return new Set();
		if (counts.size <= MAX_FOCUSED_PRS) return new Set(counts.keys());
		return new Set([...counts].filter(([, n]) => n / total >= DOMINANT_SHARE).map(([k]) => k));
	}

	const STATUS_RANK: Record<string, number> = { blocked: 4, working: 3, done: 2, idle: 1 };
	const SIGNAL_RANK: Record<PaneSignal, number> = { tag: 3, transcript: 2, branch: 1 };

	function rank(link: PaneLink): number[] {
		const best = Math.max(...link.signals.map((s) => SIGNAL_RANK[s]));
		const inProgress = (link.git?.dirty ?? 0) + (link.git?.unpushed ?? 0) > 0 ? 1 : 0;
		return [best, STATUS_RANK[link.agentStatus ?? ''] ?? 0, inProgress, link.lastChangeAt ?? 0];
	}

	async function links(prs: PaneMatchPr[]): Promise<HerdrLinksResponse> {
		const scannedAt = new Date().toISOString();
		const { socket, reason } = await socketPath();
		if (!socket) return { available: false, reason, links: {}, scannedAt };
		let panes: ScannedPane[];
		try {
			panes = await scan(socket);
		} catch (e) {
			availability = null; // re-check next time; the server may have stopped
			return { available: false, reason: `herdr did not answer: ${(e as Error).message}`, links: {}, scannedAt };
		}

		// A branch only identifies a PR when exactly one tracked PR uses it in that repo.
		const branchCount = new Map<string, number>();
		const branchKey = (hostname: string, owner: string, repo: string, branch: string) =>
			`${hostname}/${owner}/${repo}@${branch}`.toLowerCase();
		for (const pr of prs) {
			const k = branchKey(config.hosts[pr.host]?.hostname ?? '', pr.owner, pr.repo, pr.headRefName);
			branchCount.set(k, (branchCount.get(k) ?? 0) + 1);
		}

		const isBranchUnique = (pr: PaneMatchPr) =>
			branchCount.get(branchKey(config.hosts[pr.host]?.hostname ?? '', pr.owner, pr.repo, pr.headRefName)) === 1 &&
			!DEFAULT_BRANCHES.has(pr.headRefName);

		const out: Record<string, PaneLink[]> = {};
		for (const sp of panes) {
			const tagged = sp.pane.tokens?.pr ? prRefsFromTag(sp.pane.tokens.pr, prs) : new Set<string>();
			const mentionCounts = new Map<string, number>();
			if (sp.transcript) {
				for (const pr of prs) {
					const n = transcriptMentions(sp.transcript, pr, isBranchUnique(pr));
					if (n) mentionCounts.set(pr.key, n);
				}
			}
			const mentioned = focusedMentions(mentionCounts);
			for (const pr of prs) {
				const branchUnique = isBranchUnique(pr);
				const signals: PaneSignal[] = [];
				if (tagged.has(pr.key)) signals.push('tag');
				if (mentioned.has(pr.key)) signals.push('transcript');
				const g = sp.git;
				if (
					g &&
					branchUnique &&
					hostKeyByHostname.get(g.host) === pr.host &&
					g.owner.toLowerCase() === pr.owner.toLowerCase() &&
					g.repo.toLowerCase() === pr.repo.toLowerCase() &&
					g.branch === pr.headRefName
				) {
					signals.push('branch');
				}
				if (!signals.length) continue;
				(out[pr.key] ??= []).push({
					paneId: sp.pane.pane_id,
					workspaceId: sp.pane.workspace_id,
					tabId: sp.pane.tab_id,
					workspaceLabel: sp.workspaceLabel,
					tabLabel: sp.tabLabel,
					title: sp.pane.terminal_title_stripped,
					agent: sp.pane.agent,
					agentStatus: sp.pane.agent_status,
					signals,
					git: g ? { branch: g.branch, dirty: g.dirty, unpushed: g.unpushed, worktree: g.worktree } : null,
					lastChangeAt: sp.lastChangeAt,
					focused: sp.pane.focused,
				});
			}
		}
		for (const list of Object.values(out)) {
			list.sort((a, b) => {
				const ra = rank(a);
				const rb = rank(b);
				for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
				return 0;
			});
		}
		return { available: true, links: out, scannedAt };
	}

	async function focus(paneId: string): Promise<void> {
		const { socket, reason } = await socketPath();
		if (!socket) throw new Error(reason ?? 'herdr is not available');
		const { pane } = await request<{ pane: HerdrPane }>(socket, 'pane.get', { pane_id: paneId });
		await request(socket, 'workspace.focus', { workspace_id: pane.workspace_id });
		await request(socket, 'tab.focus', { tab_id: pane.tab_id });
		await request(socket, 'pane.focus', { pane_id: paneId });
	}

	return { links, focus };
}
