# jira-lite

Lightweight, Linear-style UI for Jira Cloud. Reads and writes the real Jira through its REST API, so nothing needs syncing.

No dependencies and no build step: a Python package (standard library only) serves the frontend and proxies Jira, keeping the API token out of the browser; the frontend is plain HTML, CSS and native ES modules.

## Setup

1. `cp .env.example .env` and fill in your email and API token
   (create one at https://id.atlassian.com/manage-profile/security/api-tokens)
2. `make run` (or `python3 -m jira_lite`)
3. Open http://localhost:8765

Set `PORT=9000` to use another port. `make test` runs the Python and JavaScript unit tests (needs Node 18+ for the JS tests).

## Features

- **List**: tickets grouped by status (collapsible, sticky headers), priority and status icons, sub-task progress, assignee avatars
- **Board** (`⌘B`): one column per status, drag a card to change its status
- **Sidebar**: My issues / All issues / any person; "Show done" toggle in the header
- **Peek panel**: parent link, description, sub-issues, comments and a comment box
- **Create** (`c` or the New issue button): includes the fields Jira requires; sub-issues inherit them from the parent
- **Edit in place**: status `s`, priority `p`, assignee `a`, click the title or a plain-text description to edit
- **Search**: `/` filters the loaded list, `⌘K` searches all of Jira and runs commands
- Other keys: `j`/`k` move, `Enter` open, `Esc` close, `m` comment, `r` refresh. Auto-refresh every 60 s while the tab is visible; light and dark theme follow the system.

## Project layout

```
jira_lite/          Python backend (stdlib only)
  __main__.py       entry point: python3 -m jira_lite
  app.py            builds the HTTP server from settings
  config.py         .env + environment parsing and validation
  handler.py        routing, Host and X-Jira-Lite header checks
  proxy.py          /jira/* -> {site}/rest/api/3/* forwarding
  static.py         safe static file serving from web/
web/                frontend (no build step)
  index.html        markup only
  css/              tokens (light/dark), layout, list, board, detail, overlays
  js/               ES modules: main (bootstrap), api, state, views, list, board,
                    detail, create, palette, keyboard, and pure helpers
                    (status, jql, adf, format) that are unit-tested in Node
tests/python/       unittest suite with a fake Jira upstream
tests/js/           node:test suite for the pure frontend modules
```

## Design

Colors, type and spacing follow Linear's look. The palette was derived from Linear's public theme generator (base, accent and contrast in LCH), and the icons are drawn as inline SVG. No Linear code or assets are included.
