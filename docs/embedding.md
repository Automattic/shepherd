# Embedding the client in another page

The dashboard client (`app.js`) can run in a page that another app serves. That app usually has its API at a different path, uses its own authentication, and has its own header. To tell the client about it, set `window.SHEPHERD` before `app.js` loads:

```html
<div id="shepherd"></div>
<script>
	window.SHEPHERD = {
		mount: '#shepherd',              // the element that gets the dashboard
		header: false,                   // no Shepherd brand header
		apiBase: '/my-app/api/shepherd', // replaces the "/api" prefix
		headers: { 'X-Nonce': '…' },     // added to every API call
	};
</script>
<script src="app.js" type="module"></script>
```

The client reads the object one time, when it starts. Changes to the object after that have no effect.

## Options

| Key | Purpose |
| --- | --- |
| `apiBase` | Replaces the `/api` prefix of every API call. For example, `/api/prs?reviewers=…` goes to `/my-app/api/shepherd/prs?reviewers=…`. Use a path on the same origin (it starts with one `/`) or a URL that starts with `http://` or `https://`. A URL on a different origin needs CORS on that server. The client removes a trailing `/`. |
| `headers` | An object of header names and string values. The client adds them to every API call. |
| `mount` | The element that gets the dashboard: a CSS selector or an element. The default is `#shepherd`. The client replaces the content of the element. When no element matches, the client stops with an error in the browser console. |
| `header` | `false` removes the brand header (the logo, the name and the line below it). The controls (the rate budget, the refresh interval, **Refresh now** and the theme button) stay in a bar at the top of the dashboard. This bar does not stick to the top of the window. The default is `true`. |

The host's API must give the same responses as the paths below on the local server:

- `/api/config`
- `/api/prs`
- `/api/pr`
- `/api/merged`
- `/api/followups`
- `/api/herdr/links` and `/api/herdr/focus` (only when herdr is on)

## What the host page must include

The client renders all its markup into the mount element. The host page must load these files:

- `styles.css` from the Shepherd server.
- Font Awesome 6.5.2, for the icons: `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css`.
- The Geist and Geist Mono fonts: `https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap`. Without them, the dashboard uses the system fonts.

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">
<link rel="stylesheet" href="/path/to/shepherd/styles.css">
```

## Styles

All the rules in `styles.css` start with `.shepherd`, the class that the client adds to the mount element. The CSS variables (`--bg`, `--text` and the others) and the dark theme also apply only to that element. The file does not change `html`, `body`, the elements of the host page, or the variables on `:root`. The animation names start with `shepherd-`.

- The theme button and the saved theme set `data-theme` on the mount element, not on `<html>`. Without a saved theme, the dashboard follows the system setting (`prefers-color-scheme`).
- The column headers of the list stick to the top of the window. When the host page has its own fixed header, set `--sticky-top` on the mount element to the height of that header, for example `#shepherd { --sticky-top: 56px; }`.

## Limits

- One dashboard on each page. The client keeps its state in the module, so a second mount element stays empty.
- The client keeps the IDs of its elements, for example `#q`, `#groups` and `#popover`, because its code finds them by ID. It looks for them only inside the mount element, so an element with the same ID on the host page does not change the dashboard. But a page with two elements with the same ID is not valid HTML, and the host's CSS rules for these IDs also apply to the dashboard. Do not use these IDs on the host page.
- The host's CSS rules for element names (for example `button` or `input`) also apply in the dashboard, when a rule of the client does not set the same property.
- The popover and the "Copied" tip use `position: fixed`. When an ancestor of the mount element has a `transform` or a `filter`, they show at the wrong position.
- The client renders a `<main>` element. Do not put the mount element in another `<main>`.
- The keyboard shortcuts (`R` to refresh, `/` to go to the filter, `Esc` to close the popover) work on all of the page, when the focus is not in a text field.

## Invalid values

The client ignores a value that is not valid, and uses the default for it:

- When `window.SHEPHERD` is not an object, the client ignores it.
- When `apiBase` is not a path that starts with one `/` and not a URL that starts with `http://` or `https://`, the client uses `/api`. For example, `''`, `api`, `//example.com` and `http:/example.com` are not valid.
- When `apiBase` has a `\`, a space, a tab, a newline, a `?`, a `#`, or a user name or password, the client uses `/api`.
- The client ignores each header that has a value that is not a string, or a name or value that the browser does not accept.
- When `mount` is not a string or an element, or is an empty string, the client uses `#shepherd`.
- When `header` is not `true` or `false`, the client shows the header.

## Headers and the token

The client sets the headers of each API call in this order. A later header with the same name replaces an earlier one.

1. The `headers` from `window.SHEPHERD`.
2. The headers of the call itself, for example `content-type` on a `POST`.
3. `Authorization: Bearer <token>`, when the page has a token from a `#token=` link (see [Token](configuration.md#token-optional)). The client adds it only when the headers from steps 1 and 2 have no `Authorization` header.

## Without `window.SHEPHERD`

When the page does not set `window.SHEPHERD`, the client renders the dashboard with the brand header into `#shepherd`, and sends its requests to `/api/*` with the same headers as before. The local page (`public/index.html`) has only this element. It also has the `shepherd-page` class on `<html>`, so that the page has the color of the dashboard theme. A host page does not need this class.
