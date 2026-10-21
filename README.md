# jira-lite

A fast, Linear-style web UI for Jira Cloud. It reads and writes your real Jira through the REST API, so there is no separate database and nothing to sync: teammates' changes show up on the next refresh, and your edits land in Jira immediately.

![jira-lite: issue list grouped by status with the issue panel open (light theme)](docs/screenshots/list-detail-light.png)

<table>
  <tr>
    <td><img src="docs/screenshots/board-dark.png" alt="Board view in the dark theme"></td>
    <td><img src="docs/screenshots/command-menu-dark.png" alt="Command menu (⌘K) searching issues"></td>
  </tr>
  <tr>
    <td align="center">Board view, drag a card to change its status</td>
    <td align="center">⌘K command menu: search issues, jump to a key, run commands</td>
  </tr>
</table>

<sub>Screenshots use the built-in demo data (<code>make dev-mock</code>), not a real Jira site.</sub>

- **No dependencies, no build step.** The backend is a Python package using only the standard library (3.9+); the frontend is plain HTML, CSS and native ES modules.
- **Light.** In one side-by-side measurement in Chrome's task manager, a jira-lite tab used about 30 MB against about 414 MB for a Jira board tab.
- **Two ways to run it:** on your own machine with a personal API token, or hosted on your network where everyone signs in with their own Atlassian account.

## Features

- **List** — tickets grouped by status (collapsible, sticky headers) with priority, status, sub-task progress and assignee
- **Board** (`⌘B`) — one column per status; drag a card to change its status
- **Filters** — My issues / All issues / any person in the sidebar, "Show done" in the header, `/` to filter the loaded list
- **Peek panel** — parent link, description, sub-issues, comments and a comment box
- **Create** (`c` or **New issue**) — includes the custom fields your project requires; sub-issues inherit them from the parent
- **Edit in place** — status `s`, priority `p`, assignee `a`; click the title or a plain-text description to edit it
- **Command menu** (`⌘K`) — search all issues in the project, jump to a key, run commands
- **Keyboard first** — `j`/`k` move, `Enter` open, `Esc` close, `m` comment, `r` refresh
- **Auto-refresh** every 60 s while the tab is visible, fetching only what changed
- Light and dark theme follow the system

## Quick start (just you, on your machine)

You need Python 3.9+ and a Jira Cloud account.

1. Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens (use **Create API token**, not the scoped variant).
2. `cp .env.example .env` and set `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_TOKEN` and `JIRA_PROJECT`.
3. `make run` (or `python3 -m jira_lite`) and open http://localhost:8765.

In this mode the server only listens on `localhost`, because every request uses your token.

## Hosting for a team (Sign in with Atlassian)

Each person signs in with their own Atlassian account (OAuth 2.0), so comments, transitions and new tickets are attributed to them and limited to their own Jira permissions. Nobody needs a `.env` or a token except the server.

**1. Register the app** at https://developer.atlassian.com/console/myapps/ → **Create** → **OAuth 2.0 integration** (access type *Resource-level*):
- **Permissions** → Jira API → classic scopes `read:jira-work`, `write:jira-work`, `read:jira-user`
- **Authorization** → callback URL `https://<server-address>:8765/oauth/callback` — Atlassian rejects plain `http` here unless the host is `localhost`
- **Settings** → copy the Client ID and Secret
- **Distribution** → turn on **Sharing** so people other than you can sign in

**2. Create a certificate** for the server's address (a small local certificate authority plus a server certificate, in `certs/`):

```sh
make cert HOSTS="192.168.1.20 my-server.local"
```

**3. Configure `.env`** on the server (`JIRA_EMAIL`/`JIRA_TOKEN` are not needed in this mode):

```sh
JIRA_SITE=https://your-site.atlassian.net
JIRA_PROJECT=BA
ATLASSIAN_CLIENT_ID=...
ATLASSIAN_CLIENT_SECRET=...
JIRA_LITE_BASE_URL=https://192.168.1.20:8765      # must match the registered callback origin
JIRA_LITE_TLS_CERT=certs/server.crt
JIRA_LITE_TLS_KEY=certs/server.key
JIRA_LITE_PUBLIC_HOSTS=192.168.1.20,my-server.local
JIRA_LITE_BIND=0.0.0.0
```

**4. Run** `make run` and share the link. Each colleague trusts `certs/ca.crt` once to avoid the browser warning (macOS: open it in Keychain Access and set *Trust* to *Always Trust*; Windows: install it into *Trusted Root Certification Authorities*), then clicks **Sign in with Atlassian**.

Good to know:
- Sessions are kept in memory; restarting the server signs everyone out. Idle sessions expire after 30 days.
- Atlassian rate-limits OAuth apps per app (about 65,000 points per hour across all users, roughly one point per issue returned). jira-lite stays well under this by refreshing only issues updated since the last check, with a full reload on filter changes, manual refresh and every 10 minutes.
- Your Atlassian organization admin can block user-installed OAuth apps; if colleagues see "not allowed" on the consent screen, ask them.

## Configuration reference

| Key | Mode | Meaning |
|---|---|---|
| `JIRA_SITE` | both | Your Jira Cloud URL, e.g. `https://your-site.atlassian.net` |
| `JIRA_PROJECT` | both | Project key shown in the UI (default `BA`) |
| `JIRA_EMAIL`, `JIRA_TOKEN` | token | Your Atlassian email and API token |
| `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` | OAuth | From the developer console; setting the Client ID turns OAuth mode on |
| `JIRA_LITE_BASE_URL` | OAuth | Public origin colleagues use; the callback is `<BASE_URL>/oauth/callback` |
| `JIRA_LITE_TLS_CERT`, `JIRA_LITE_TLS_KEY` | both | Serve HTTPS with this certificate and key (paths relative to the project) |
| `JIRA_LITE_PUBLIC_HOSTS` | both | Extra host names/IPs the browser may use, comma separated |
| `JIRA_LITE_BIND` | OAuth | Listen address; anything other than loopback requires OAuth mode and TLS |
| `PORT` | both | Port to listen on (default `8765`), from the environment |

Values in `.env` can be overridden by environment variables of the same name.

## Security

- Credentials stay on the server: the browser only talks to the local proxy, never to Jira directly.
- Requests must be addressed to an allowed host (DNS-rebinding protection) and API calls must carry an `X-Jira-Lite` header, which other websites cannot send without a CORS preflight that the server never grants.
- Session cookies are `HttpOnly` and `SameSite=Lax` (and `Secure` over HTTPS); the OAuth `state` is bound to the browser and checked on callback; tokens, codes and secrets are never logged.
- In token mode the server refuses to listen on the network.

## Development

```sh
make test       # Python (unittest, fake Jira/Atlassian servers) + JavaScript (node:test, Node 18+)
make test-py
make test-js
```

```
jira_lite/      backend: config, app (server + TLS), handler (routing, checks),
                proxy (token mode), auth/oauth/sessions (OAuth mode), static files
web/            frontend: index.html, css/ (tokens, layout, views), js/ (ES modules;
                pure helpers such as status, jql, adf, sync are unit-tested in Node)
tests/python/   backend tests
tests/js/       frontend tests
scripts/        make-cert.sh
```

See `CLAUDE.md` for a deeper tour of the architecture.

## Design

Colors, type and spacing follow Linear's look. The palette was derived from Linear's public theme generator (base, accent and contrast in LCH), and all icons are drawn as inline SVG. No Linear code or assets are included.
