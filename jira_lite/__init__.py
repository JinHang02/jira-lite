"""jira-lite: a small local web UI for Jira Cloud.

The package serves the single-page frontend from ``web/`` and proxies
``/jira/*`` and ``/agile/*`` to the Jira Cloud REST APIs, keeping the API
token on the server side. Standard library only.

Run with ``python3 -m jira_lite`` (or ``python3 server.py``).
"""

__version__ = "0.2.0"
