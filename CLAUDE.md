# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

jira-lite is a lightweight, Linear-style web UI for one Jira Cloud project (site and project come from `.env`, default project `BA`). It reads and writes the real Jira through the REST API v3 — there is no local data store and nothing to sync. A small Python server serves the frontend and proxies Jira so credentials never reach the browser (Jira Cloud also blocks browser CORS).

Hard constraints the user chose: **no dependencies and no build step**. Backend = Python standard library only, compatible with Python 3.9 (no `match`, no `X | Y` type unions). Frontend = plain HTML/CSS + native ES modules, no npm, no bundler, no framework.

## Commands

```sh
make run                      # python3 -m app  (http://localhost:8765; PORT=... to change)
make test                     # both suites
make test-py                  # python3 -m unittest discover -s tests/python -t .
make test-js                  # node --test tests/js/*.test.mjs   (Node 26 rejects a bare directory)
make cert HOSTS="192.168.0.113 host.local"   # local CA + server cert in certs/ (gitignored)

# single tests
python3 -m unittest tests.python.test_config.ExposureSettingsTest.test_public_hosts_are_split_and_trimmed
node --test --test-name-pattern "buildJql" tests/js/jql.test.mjs

# end-to-end testing (fake Jira, never the real one)
python3 -m unittest discover -s tests/e2e -t .                  # smoke test: app proxy + mock, all write paths
python3 tests/e2e/mock_jira.py --port 9900 --app-port 8900      # mock Jira + app on http://localhost:8900 (ignores .env)
python3 tests/e2e/mock_jira.py --port 9900 --log /tmp/jira.jsonl --latency-ms 300   # mock only; GET /__mock/requests, POST /__mock/reset
make test-browser                                               # headless Playwright run of tests/e2e/browser_e2e.js (starts mock + app on 9900/8900)
E2E_ONLY="^fresh" E2E_SHOTS=/tmp/shots make test-browser        # only matching checks; screenshot every failure
```
The mock's search can lag behind writes like Jira Cloud's index (`--index-lag-ms N`, or `POST /__mock/config?indexLagMs=N`) and return smaller pages (`?maxPage=N`, to exercise the "500+" cut-offs); the browser run's `fresh:` checks use a 5 s lag and require every write to show within 2 s. Verify UI changes with `make test-browser` (and screenshots) as well as the unit suites.
`tests/e2e/CHECKLIST.md` lists every UI flow with its expected result (manual / Playwright). JQL or endpoints the mock doesn't know answer 400/404 with an `errorMessages` entry — extend `mock_jira.py` when the frontend starts sending something new.

Config lives in `.env` (see `.env.example`); `JIRA_*`/`JIRA_LITE_*` process env vars override it, `PORT` comes from the environment only.

## Architecture

**Request flow:** browser → `app` server → `/jira/<rest>` is forwarded to Jira REST v3; `/config` returns non-secret settings (incl. `auth`); everything else is a static file from `web/`.

**Two auth modes** (chosen in `config.py`): *token mode* (no `ATLASSIAN_CLIENT_ID`) forwards to `{JIRA_SITE}/rest/api/3/` with one person's Basic-auth API token and may only bind to loopback. *OAuth mode* (`ATLASSIAN_CLIENT_ID` set) is per-user "Sign in with Atlassian" (OAuth 2.0 3LO): `auth.py` handles `/oauth/login`, `/oauth/callback`, `/auth/me`, `/auth/logout` and proxies to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/` with each session's Bearer token; `oauth.py` talks to Atlassian; `sessions.py` is an in-memory store (restart signs everyone out). Refresh tokens rotate, so refreshes run under a per-session lock — never refresh outside it. A missing/expired session answers 401 with header `X-Jira-Lite-Auth: login`, which the frontend (`auth.js`) turns into the sign-in screen. Network binding (`JIRA_LITE_BIND=0.0.0.0`) is only allowed in OAuth mode with TLS; `JIRA_LITE_BASE_URL` must equal the callback origin registered in the Atlassian developer console.

**Writes are read-your-writes, not re-searches.** Jira Cloud's `/search/jql` is eventually consistent (it can return the pre-write issue, or miss a new one, for seconds); `GET issue/{key}` is current. So every write goes through `edits.settle(keys, {deleted})`: it fetches the touched issues and their parents by key, records them in the overlay (`overlay.js`, pure) and merges them into the list (`views.reconcile`), then reloads the open panel and, when epics are involved, their progress. Every search result — full load, delta, sub-issues, epic progress — passes through `writes.apply(...)`, which swaps in fresher copies, adds created ones and drops deleted ones until the index has caught up (same `updated` with equal values, or newer; 10-min TTL). Searches that may add issues go through `edits.withWrites`, which first re-reads by key each remembered issue the search left out: it may be missing because someone else moved it out of the view since, and our stale copy must not bring it back. Status/priority/assignee writes are also optimistic (`patchLocal`), with `settle` correcting or undoing them. A new write path must call `settle` (or `updateFields`/`updateOps`/`transition`, which do) — never refresh by searching. List fields (labels, fix versions, components) are written with Jira's `update` add/remove verbs (`bulk.listOps`), so a value someone else added meanwhile isn't overwritten; a pick-list field whose editmeta lacks those verbs (`props.canAddRemove`) falls back to a whole-list `set`.

**Rate limit:** OAuth apps share ~65k points/hour across all users (≈1 point per returned issue), so auto-refresh is a delta sync (`sync.js`: `updated >= -Nm`, merged client-side with `matchesView`), with a full reload only on filter changes, manual refresh and every 10 min. Don't reintroduce periodic full reloads. `/priority/search` needs an admin scope under OAuth; priorities come from createmeta (`priorities.js`, `meta.js`).

**Backend (`app/`)** — `config.py` parses/validates settings into a frozen `Settings` (raises `ConfigError`; only `__main__.py` turns that into exit codes). `app.py` builds a `ThreadingHTTPServer` subclass that carries settings, the proxy and the web root, and optionally wraps the socket in TLS (handshake deferred to worker threads). `handler.py` is thin routing; the logic is in `proxy.py` (URL mapping + forwarding with an injectable opener) and `static.py` (realpath-contained file serving).

Security invariants that tests enforce — keep them when changing the server:
- Every request's `Host` must be in `allowed_hosts` (localhost/127.0.0.1 + `JIRA_LITE_PUBLIC_HOSTS`, with port) — DNS-rebinding protection.
- Proxy calls require header `X-Jira-Lite: 1`. Because no `OPTIONS` handler exists, cross-site pages can't pass the CORS preflight that this header forces. The frontend's `api.js` always sends it.
- `..` (literal or percent-encoded) in proxy or static paths is rejected.
- `config.py` refuses a non-loopback `JIRA_LITE_BIND` while auth is a single shared API token — exposing it would let anyone on the network act as that person.
- Every response carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (`handler._no_framing`): in token mode the server holds the credentials, so a framed app could be clickjacked into edits or deletes.
- `/files/` downloads are same-origin only (`files.fetch_allowed`): `Sec-Fetch-Site` same-origin/none, or a top-level navigation whose Referer/Origin is ours (Safari marks `target=_blank rel=noopener` clicks `cross-site`); cross-site subresources are refused whatever their Referer. `/files/media/{id}` (JSON, needs `X-Jira-Lite`) reads an attachment's Media Services id from Jira's redirect without following it.

**Frontend (`web/`)** — `index.html` is markup only; `css/tokens.css` holds all colors (light + dark via `prefers-color-scheme`), derived from Linear's theme. `js/main.js` is the only bootstrap. Module conventions that span files:
- `state.js` exports one shared mutable `state` object (data, view state, persisted prefs via `localStorage` under `jl.*`).
- Views never import each other. Cross-view calls go through `actions.js` (`actions.openIssue(...)` etc.), which `main.js` wires once. Adding a new cross-view entry point means adding its name to `NAMES` in `actions.js` and passing it to `wire()` in `main.js` (wire throws on missing/unknown names).
- Pure modules — `status.js`, `jql.js`, `adf.js` helpers, `markdown.js`, `format.js`, `issues.js`, `sync.js`, `display.js` (grouping/ordering), `people.js`, `priorities.js`, `props.js`, `activity.js` (changelog + comments timeline), `shortcuts.js`, `overlay.js`, `drafts.js` — must not touch `document`/`window` at import time; they are what `tests/js/` covers (one `*.test.mjs` per module). Put new logic in a pure module with a test and keep the DOM module thin.
- The proxy forwards GET, POST, PUT and DELETE (comment delete); every write path needs the `X-Jira-Lite` header and, in OAuth mode, a matching `Origin`.
- `api.js` is the only place that talks to the server; it uses `POST /search/jql` with `nextPageToken` pagination (the old `/search` endpoint is deprecated).
- Static caching: the server rewrites `js/`/`css/` URLs in `index.html` and relative imports in every `.js` to `?v=<app_version>` (a hash over all of `web/`), served `immutable` for a year; `index.html` and unversioned URLs get `no-cache` + ETag. Edits need no manual cache-busting, but every module must stay in `index.html`'s `<link rel="modulepreload">` list — `test_smoke` fails when the list and the import graph differ.
- Searches that stop at a page limit say so instead of truncating silently: `api.searchPages` returns `{issues, more}` (`hasMore(page)` for one page) and the UI shows "500+" (list count, with a tooltip), "n/100+" (sub-issues) and "n/m+" (epic progress).
- Unsaved editor text survives a session ending (OAuth restart/expiry): every editor registers a snapshot with `drafts.track()`; `auth.requireLogin` stashes them and `detail.renderDetail` reopens the title/description/comment editors after sign-in (description drafts carry their ⟦n⟧ blocks). A new inline editor should `track()` itself too.
- List refresh races (a slow old answer overwriting a newer view) are guarded by `sync.createLoads()`; what a delta page or an auto-refresh triggers is decided by `deltaStep`/`followUps` — keep that logic in `sync.js` with its tests.
- `detail.js` keeps the last 30 opened issues (`recent`) so reopening renders at once while the fresh copy loads; drop an entry when its load fails.

**Jira-specific behavior worth knowing:**
- Rich text is ADF (Atlassian Document Format). `adf.js` renders it by building DOM nodes — never `innerHTML` for Jira content. (`icon()` uses `innerHTML` only for constant SVG strings.) Comments are sent as ADF built by `textToAdf`. Descriptions are edited as Markdown (`markdown.js`): any block or inline node that wouldn't survive the round trip (images, tables, panels, underline…) is shown as a `⟦n · …⟧` placeholder and put back unchanged, so an edit never loses content — keep that guard (`toMarkdown` re-parses every block and compares) when adding syntax.
- Images pasted/dropped into the description editor (`descimages.js`) are uploaded as attachments, then embedded as `mediaSingle > media{type:file, id, collection:""}`. The media id is not in the attachment JSON: the server's `GET /files/media/{attachmentId}` reads it from Jira's attachment-download redirect (`…/file/{uuid}/binary`) without following it.
- Deleting an issue (`deleteview.js`, header trash button) needs "delete" typed in the dialog; it sends `DELETE issue/{key}?deleteSubtasks=true` when there are sub-tasks.
- Editable properties come from `GET issue/{key}/editmeta` (cached per issue + type in `detail.js`): pick lists for option/version/component fields (`props.js` `pickKind`), reporter when `set` is allowed, and the issue-type chip from `issuetype.allowedValues` (Jira lists it with no operations but accepts a PUT; it may still refuse hierarchy changes like Task → Epic).
- Status grouping uses `statusKind()` (status category + name heuristics → backlog/todo/started/review/blocked/done/canceled). List groups, board columns and Display › Statuses all use the workflow order `BOARD_ORDER` (the user found the old active-first list order confusing next to the board). The app deliberately does **not** read a Jira board's configuration (the user found that confusing; it was removed).
- Create: the BA project's create screen requires custom fields (e.g. Client, Fix versions). `create.js` reads createmeta for the chosen issue type and renders a select for every required field that has `allowedValues`; sub-issues inherit those values from the parent, otherwise the last-used values are preselected.
- Priority icons are Jira-style coloured chevrons/`=`; the earlier Linear-style bar icon was replaced because it looked like a network-signal indicator.

## Working in this repo

- Testing against the live Jira: read-only requests are fine with a short timeout (≤30 s). Do not create, edit, transition or comment on real tickets without the user's explicit OK — verify write paths against a mock Jira (run the server with `JIRA_SITE=http://127.0.0.1:<port>` pointing at a fake).
- Never print or commit `.env` or anything in `certs/`.
- Run `make test` before committing; the Python tests use fake upstream servers on ephemeral ports and never hit the network.
