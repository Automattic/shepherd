// The static markup of the dashboard. The client renders it into the mount element
// (see `mount` and `header` in src/embed.ts), so a host page needs only that element.
// web/app.ts finds these elements by ID, inside the mount element.

import { DEFAULT_MOUNT, type ShepherdEmbedOptions } from '../src/embed.ts';

const BRAND = `
		<div class="brand">
			<span class="brand-mark"><i class="fa-solid fa-code-pull-request"></i></span>
			<div>
				<h1>Shepherd</h1>
				<p class="brand-sub" id="brand-sub">Open pull requests across the team</p>
			</div>
		</div>`;

function shellHtml(header: boolean): string {
	return `
	<header class="topbar">${header ? BRAND : ''}
		<div class="controls">
			<div class="view-note" id="view-note" hidden></div>
			<div class="rate" id="rate" title="github.com GraphQL budget"></div>
			<div class="seg" id="interval" role="radiogroup" aria-label="Refresh interval"></div>
			<button class="icon-btn" id="refresh" title="Refresh now (R)" aria-label="Refresh now"><i class="fa-solid fa-rotate"></i></button>
			<button class="icon-btn" id="theme" title="Toggle light and dark" aria-label="Toggle theme"><i class="fa-solid fa-moon"></i></button>
			<button class="icon-btn" id="settings-btn" title="Settings" aria-label="Settings" hidden><i class="fa-solid fa-gear"></i></button>
		</div>
		<div class="tickbar"><span id="tick"></span></div>
	</header>

	<main>
		<div class="banner" id="banner" hidden></div>

		<section class="tiles" id="tiles" aria-label="Summary"></section>

		<details class="shipped" id="shipped" hidden>
			<summary><i class="fa-solid fa-code-merge"></i> Shipped <span class="shipped-count" id="shipped-count"></span></summary>
			<div class="shipped-body">
				<div class="shipped-controls">
					<div class="seg" id="shipped-range" role="radiogroup" aria-label="Merged in"></div>
					<span id="shipped-filter"></span>
				</div>
				<p class="shipped-people" id="shipped-people"></p>
				<ul class="shipped-list" id="shipped-list"></ul>
			</div>
		</details>

		<section class="filters" id="filters">
			<div class="people" id="people" aria-label="People"></div>
			<div class="filter-row">
				<div class="repos" id="repos"></div>
				<div class="repos" id="approvals" aria-label="Approval filters"></div>
				<div class="toggles" id="toggles"></div>
				<div class="seg" id="sort" role="radiogroup" aria-label="Sort order"></div>
				<label class="search">
					<i class="fa-solid fa-magnifying-glass"></i>
					<input id="q" type="search" placeholder="Filter by title, branch, ticket" autocomplete="off">
				</label>
				<!-- Narrow screens only: the chip groups above collapse behind this button. -->
				<button class="filters-btn" id="filters-btn" type="button" aria-expanded="false" aria-controls="people repos approvals toggles sort">
					<i class="fa-solid fa-sliders"></i>Filters<span class="count" id="filters-count" hidden></span>
				</button>
			</div>
		</section>

		<section class="board" aria-label="Pull requests">
			<div class="grid-head" role="row">
				<div>Pull request</div>
				<div><i class="fa-regular fa-hourglass-half"></i> Waiting on</div>
				<div><i class="fa-regular fa-circle-check"></i> Approvals</div>
				<div><i class="fa-solid fa-robot"></i> <span id="ai-review-label">AI review</span></div>
				<div title="Everyone who commented or reviewed, most recently active first"><i class="fa-solid fa-comments"></i> Participants</div>
				<div><i class="fa-solid fa-signal"></i> Status</div>
				<div class="right">Updated</div>
			</div>
			<div id="groups"></div>
			<div class="empty" id="empty" hidden></div>
		</section>
	</main>

	<div class="popover" id="popover" hidden></div>
`;
}

/**
 * Finds the mount element and renders the dashboard markup into it. It replaces the content of
 * the element. Throws when the element does not exist.
 */
export function mountShell(opts: ShepherdEmbedOptions): HTMLElement {
	const mount = opts.mount ?? DEFAULT_MOUNT;
	const root = typeof mount === 'string' ? document.querySelector(mount) : mount;
	if (!(root instanceof HTMLElement)) throw new Error(`Shepherd: no mount element for ${String(mount)}`);
	const header = opts.header !== false;
	root.classList.add('shepherd');
	root.classList.toggle('no-header', !header);
	root.innerHTML = shellHtml(header);
	return root;
}
