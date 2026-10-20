# jira-lite

Lightweight local UI for Jira Cloud. Reads and writes the real Jira through its REST API, so nothing needs syncing.

One Python file (standard library only) serves the page and proxies to Jira, keeping the API token out of the browser. One HTML file, no build step.

## Setup

1. `cp .env.example .env` and fill in your email and API token
   (create one at https://id.atlassian.com/manage-profile/security/api-tokens)
2. `python3 server.py`
3. Open http://localhost:8765

Set `PORT=9000` to use another port.

## Features

- Linear-style list: tickets grouped by status (collapsible, sticky headers), priority and status icons, assignee avatars
- Sidebar: My issues / All issues / any person; "Show done" toggle in the header
- Side panel ("peek") with description, comments and a comment box (Cmd/Ctrl+Enter sends)
- Status menu applies Jira transitions (click the status icon or press `s`)
- Keyboard: `j`/`k` move, `Enter` open, `Esc` close, `s` status, `c` comment, `r` refresh
- Auto-refresh every 60 s while the tab is visible; light and dark theme follow the system

## Design

Colors, type and spacing follow Linear's look. The palette was derived from Linear's public theme generator (base, accent and contrast in LCH), and the icons are redrawn from their shapes as inline SVG. No Linear code or assets are included.
