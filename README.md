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

- Ticket list for the project: Mine / Everyone / one person; Done hidden unless "Show Done" is ticked
- Click a ticket for description and comments
- Status dropdown applies Jira transitions
- Comment box (Cmd/Ctrl+Enter sends)
- Auto-refresh every 60 s while the tab is visible
