# GitHub Enterprise and proxies

Add the Enterprise host under `hosts`, give each person a login for it, and point repos at it:

```json
"hosts": {
  "github": { "hostname": "github.com", "label": "GitHub", "bot": null },
  "work": { "hostname": "github.example.com", "label": "GHE", "concurrency": 8, "bot": "review-bot" }
}
```

Sign `gh` in to it with `gh auth login --hostname github.example.com`.

If the host is only reachable through a SOCKS proxy, install `proxychains4`, point a config file at the proxy, and set `"proxychains": "~/.proxychains.conf"` on that host. Shepherd then runs `gh` through it for that host only. Check access the same way Shepherd will:

```sh
proxychains4 -q -f ~/.proxychains.conf gh auth status --hostname github.example.com
```

Don't leave `GH_HOST` exported in your shell. Shepherd removes it from its own `gh` calls, but your manual checks would go to the wrong host.
