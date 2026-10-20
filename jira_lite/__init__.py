"""jira-lite: a small local web UI for Jira Cloud.

The package serves the single-page frontend from ``web/`` and proxies
``/jira/*`` to the Jira Cloud REST API, keeping credentials on the server
side: either one shared API token, or per-user "Sign in with Atlassian"
(OAuth 2.0 3LO) sessions. Standard library only.

Run with ``python3 -m jira_lite`` (or ``python3 server.py``).
"""

__version__ = "0.2.0"
