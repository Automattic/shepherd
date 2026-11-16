# Embedding the client in another page

The dashboard client (`app.js`) can run in a page that another app serves. That app usually has its API at a different path and uses its own authentication. To tell the client about it, set `window.SHEPHERD` before `app.js` loads:

```html
<script>
	window.SHEPHERD = {
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
| `apiBase` | Replaces the `/api` prefix of every API call. For example, `/api/prs?reviewers=…` goes to `/my-app/api/shepherd/prs?reviewers=…`. Use a path on the same origin (it starts with one `/`) or an `http` or `https` URL. A URL on a different origin needs CORS on that server. The client removes a trailing `/`. |
| `headers` | An object of header names and string values. The client adds them to every API call. |

The host's API must give the same responses as the paths below on the local server:

- `/api/config`
- `/api/prs`
- `/api/pr`
- `/api/merged`
- `/api/followups`
- `/api/herdr/links` and `/api/herdr/focus` (only when herdr is on)

## Invalid values

The client ignores a value that is not valid, and uses the default for it:

- When `window.SHEPHERD` is not an object, the client ignores it.
- When `apiBase` is not a string, is empty, is a relative path such as `api`, starts with `//`, or is a URL that is not `http` or `https`, the client uses `/api`.
- When `apiBase` has a `\`, a space, a tab, a newline, a `?`, a `#`, or a user name or password, the client uses `/api`.
- The client ignores each header that has a value that is not a string, or a name or value that the browser does not accept.

## Headers and the token

The client sets the headers of each API call in this order. A later header with the same name replaces an earlier one.

1. The `headers` from `window.SHEPHERD`.
2. The headers of the call itself, for example `content-type` on a `POST`.
3. `Authorization: Bearer <token>`, when the page has a token from a `#token=` link (see [Token](configuration.md#token-optional)). The client adds it only when the headers from steps 1 and 2 have no `Authorization` header.

## Without `window.SHEPHERD`

When the page does not set `window.SHEPHERD`, the client sends its requests to `/api/*` with the same headers as before. The local server does not use these options.
