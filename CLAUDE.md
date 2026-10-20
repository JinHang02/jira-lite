# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

jira-lite is a lightweight, Linear-style web UI for one Jira Cloud project (site and project come from `.env`, default project `BA`). It reads and writes the real Jira through the REST API v3 — there is no local data store and nothing to sync. A small Python server serves the frontend and proxies Jira so credentials never reach the browser (Jira Cloud also blocks browser CORS).

Hard constraints the user chose: **no dependencies and no build step**. Backend = Python standard library only, compatible with Python 3.9 (no `match`, no `X | Y` type unions). Frontend = plain HTML/CSS + native ES modules, no npm, no bundler, no framework.

## Commands

```sh
make run                      # python3 -m jira_lite  (http://localhost:8765; PORT=... to change)
make test                     # both suites
make test-py                  # python3 -m unittest discover -s tests/python -t .
make test-js                  # node --test tests/js/*.test.mjs   (Node 26 rejects a bare directory)
make cert HOSTS="192.168.0.113 host.local"   # local CA + server cert in certs/ (gitignored)

# single tests
python3 -m unittest tests.python.test_config.ExposureSettingsTest.test_public_hosts_are_split_and_trimmed
node --test --test-name-pattern "buildJql" tests/js/jql.test.mjs
```

`python3 server.py` is a shim for `python3 -m jira_lite`. Config lives in `.env` (see `.env.example`); `JIRA_*`/`JIRA_LITE_*` process env vars override it, `PORT` comes from the environment only.

## Architecture

**Request flow:** browser → `jira_lite` server → `/jira/<rest>` is forwarded to Jira REST v3; `/config` returns non-secret settings (incl. `auth`); everything else is a static file from `web/`.

**Two auth modes** (chosen in `config.py`): *token mode* (no `ATLASSIAN_CLIENT_ID`) forwards to `{JIRA_SITE}/rest/api/3/` with one person's Basic-auth API token and may only bind to loopback. *OAuth mode* (`ATLASSIAN_CLIENT_ID` set) is per-user "Sign in with Atlassian" (OAuth 2.0 3LO): `auth.py` handles `/oauth/login`, `/oauth/callback`, `/auth/me`, `/auth/logout` and proxies to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/` with each session's Bearer token; `oauth.py` talks to Atlassian; `sessions.py` is an in-memory store (restart signs everyone out). Refresh tokens rotate, so refreshes run under a per-session lock — never refresh outside it. A missing/expired session answers 401 with header `X-Jira-Lite-Auth: login`, which the frontend (`auth.js`) turns into the sign-in screen. Network binding (`JIRA_LITE_BIND=0.0.0.0`) is only allowed in OAuth mode with TLS; `JIRA_LITE_BASE_URL` must equal the callback origin registered in the Atlassian developer console.

**Rate limit:** OAuth apps share ~65k points/hour across all users (≈1 point per returned issue), so auto-refresh is a delta sync (`sync.js`: `updated >= -Nm`, merged client-side with `matchesView`), with a full reload only on filter changes, manual refresh and every 10 min. Don't reintroduce periodic full reloads. `/priority/search` needs an admin scope under OAuth; priorities come from createmeta (`priorities.js`, `meta.js`).

**Backend (`jira_lite/`)** — `config.py` parses/validates settings into a frozen `Settings` (raises `ConfigError`; only `__main__.py` turns that into exit codes). `app.py` builds a `ThreadingHTTPServer` subclass that carries settings, the proxy and the web root, and optionally wraps the socket in TLS (handshake deferred to worker threads). `handler.py` is thin routing; the logic is in `proxy.py` (URL mapping + forwarding with an injectable opener) and `static.py` (realpath-contained file serving).

Security invariants that tests enforce — keep them when changing the server:
- Every request's `Host` must be in `allowed_hosts` (localhost/127.0.0.1 + `JIRA_LITE_PUBLIC_HOSTS`, with port) — DNS-rebinding protection.
- Proxy calls require header `X-Jira-Lite: 1`. Because no `OPTIONS` handler exists, cross-site pages can't pass the CORS preflight that this header forces. The frontend's `api.js` always sends it.
- `..` (literal or percent-encoded) in proxy or static paths is rejected.
- `config.py` refuses a non-loopback `JIRA_LITE_BIND` while auth is a single shared API token — exposing it would let anyone on the network act as that person.

**Frontend (`web/`)** — `index.html` is markup only; `css/tokens.css` holds all colors (light + dark via `prefers-color-scheme`), derived from Linear's theme. `js/main.js` is the only bootstrap. Module conventions that span files:
- `state.js` exports one shared mutable `state` object (data, view state, persisted prefs via `localStorage` under `jl.*`).
- Views never import each other. Cross-view calls go through `actions.js` (`actions.openIssue(...)` etc.), which `main.js` wires once. Adding a new cross-view entry point means adding its name to `NAMES` in `actions.js` and passing it to `wire()` in `main.js` (wire throws on missing/unknown names).
- Pure modules — `status.js`, `jql.js`, `adf.js` helpers, `format.js`, `issues.js` — must not touch `document`/`window` at import time; they are what `tests/js/` covers.
- `api.js` is the only place that talks to the server; it uses `POST /search/jql` with `nextPageToken` pagination (the old `/search` endpoint is deprecated).

**Jira-specific behavior worth knowing:**
- Rich text is ADF (Atlassian Document Format). `adf.js` renders it by building DOM nodes — never `innerHTML` for Jira content. (`icon()` uses `innerHTML` only for constant SVG strings.) Comments/descriptions are sent as ADF built by `textToAdf`; description editing is only offered when `plainSafe()` says plain-text editing would lose nothing, otherwise the UI links to Jira.
- Status grouping uses `statusKind()` (status category + name heuristics → backlog/todo/started/review/blocked/done/canceled). The list orders groups by `KIND_ORDER`, the board orders columns by `BOARD_ORDER`. The app deliberately does **not** read a Jira board's configuration (the user found that confusing; it was removed).
- Create: the BA project's create screen requires custom fields (e.g. Client, Fix versions). `create.js` reads createmeta for the chosen issue type and renders a select for every required field that has `allowedValues`; sub-issues inherit those values from the parent, otherwise the last-used values are preselected.
- Priority icons are Jira-style coloured chevrons/`=`; the earlier Linear-style bar icon was replaced because it looked like a network-signal indicator.

## Working in this repo

- Testing against the live Jira: read-only requests are fine with a short timeout (≤30 s). Do not create, edit, transition or comment on real tickets without the user's explicit OK — verify write paths against a mock Jira (run the server with `JIRA_SITE=http://127.0.0.1:<port>` pointing at a fake).
- Never print or commit `.env` or anything in `certs/`.
- Run `make test` before committing; the Python tests use fake upstream servers on ephemeral ports and never hit the network.
