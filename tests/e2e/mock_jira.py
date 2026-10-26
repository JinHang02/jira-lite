"""A fake Jira Cloud (REST API v3 subset) for exercising jira-lite end to end.

Standard library only, Python 3.9+. Serves ``/rest/api/3/...`` so the app's token-mode
proxy works unchanged (``JIRA_SITE=http://127.0.0.1:<port>``); ``/ex/jira/<cloudId>/rest/api/3/``
(the OAuth gateway form) is accepted too. Everything lives in memory and is reseeded on start
and on ``POST /__mock/reset``. The seed is deterministic; its timestamps are relative to the
moment of seeding, so due dates, "overdue" and ``updated >= -Nm`` behave the same every run.

Covered (what jira-lite calls, plus a few neighbours):
  GET  myself, priority, priority/search, project/{key}, project/{key}/statuses,
       user/assignable/search, issue/createmeta/{project}/issuetypes[/{typeId}]
  POST search/jql (also GET)  -- nextPageToken pagination, small JQL evaluator (see Jql)
  GET  issue/{key}[?fields=..&expand=changelog], issue/{key}/changelog, issue/{key}/editmeta
  PUT  issue/{key}            -- summary, description, priority, labels, duedate, parent,
                                 assignee, reporter, issuetype, customfield_10050 (Client),
                                 fixVersions, components
  POST issue                  -- validates required fields like Jira (400 errors{})
  DELETE issue/{key}[?deleteSubtasks=true] -- refuses an issue with sub-tasks without the flag;
                                 an epic's children lose their parent
  PUT  issue/{key}/assignee
  GET|POST issue/{key}/transitions   -- workflow graph enforced
  GET|POST issue/{key}/comment, GET|PUT|DELETE issue/{key}/comment/{id}
  POST issue/{key}/attachments  -- multipart/form-data, needs X-Atlassian-Token: no-check
  GET  attachment/content|thumbnail/{id} -- 303 to /__mock/media/file/{mediaId}/binary?id=..&token=..
                                (Media Services' URL shape: the file id is what ADF media nodes name)
  GET  user/search?query=
  GET  /browse/{key}          -- a tiny HTML page, so "Open in Jira" links go somewhere

Anything else answers 404 with an ``errorMessages`` entry naming the route, and JQL the
evaluator doesn't understand answers 400, so gaps in the mock are visible rather than silent.
Field edits and transitions bump ``updated`` and append changelog histories; comment writes
bump ``updated`` only (Jira keeps comments out of the changelog too).

Search is eventually consistent, like Jira Cloud's index: with an index lag (``--index-lag-ms N``
or ``POST /__mock/config?indexLagMs=N``; default 0) ``search/jql`` sees every issue as it was N ms
ago, while ``GET issue/{key}`` and the other REST reads are always current.

Test hooks: ``GET /__mock/requests[?since=N]`` lists recorded requests ({seq, method, path,
body, status, auth}); ``POST /__mock/reset`` reseeds and clears them (the index lag stays).
``--log FILE`` appends every request as one JSON line.

CLI::

    python3 tests/e2e/mock_jira.py --port 9900 [--log file] [--latency-ms N] [--index-lag-ms N]
    python3 tests/e2e/mock_jira.py --port 9900 --app-port 8900   # also run jira-lite against it
"""

import argparse
import base64
import copy
import hashlib
import html
import json
import os
import re
import struct
import sys
import threading
import time
import uuid
import zlib
from datetime import datetime, timedelta, timezone
from email import policy as email_policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

PROJECT_KEY = "DEMO"
PROJECT_ID = "10000"
API = "/rest/api/3/"
GATEWAY_RE = re.compile(r"^/ex/jira/[^/]+(/rest/api/3/.*)$")
CLIENT_FIELD = "customfield_10050"
MAX_PAGE = 100
CHANGELOG_PAGE = 100

# ---------------------------------------------------------------------------------------------
# Static reference data
# ---------------------------------------------------------------------------------------------

ME_ID = "712020:5c3e1f0a-8d2b-4e6f-9a10-6d0e3b2c1a01"
ALICE_ID = "712020:5c3e1f0a-8d2b-4e6f-9a10-6d0e3b2c1a02"
BOB_ID = "712020:5c3e1f0a-8d2b-4e6f-9a10-6d0e3b2c1a03"
CAROL_ID = "712020:5c3e1f0a-8d2b-4e6f-9a10-6d0e3b2c1a04"
BOT_ID = "557058:f58131cb-b67d-43c7-b30d-6b58d40bd077"

USERS = [  # (accountId, displayName, accountType, email)
    (ME_ID, "Sam Rivera", "atlassian", "sam.rivera@example.com"),
    (ALICE_ID, "Alice Nguyen", "atlassian", "alice.nguyen@example.com"),
    (BOB_ID, "Bob Okafor", "atlassian", "bob.okafor@example.com"),
    (CAROL_ID, "Carol Schmidt", "atlassian", "carol.schmidt@example.com"),
    (BOT_ID, "Automation for Jira", "app", ""),
]
SHORT = {"me": ME_ID, "alice": ALICE_ID, "bob": BOB_ID, "carol": CAROL_ID, "bot": BOT_ID, None: None}

CATEGORIES = {
    "new": {"id": 2, "key": "new", "colorName": "blue-gray", "name": "To Do"},
    "indeterminate": {"id": 4, "key": "indeterminate", "colorName": "yellow", "name": "In Progress"},
    "done": {"id": 3, "key": "done", "colorName": "green", "name": "Done"},
}
STATUSES = [  # (id, name, category key, description)
    ("10000", "Backlog", "new", "Not planned yet."),
    ("10001", "To Do", "new", "Planned and ready to be picked up."),
    ("3", "In Progress", "indeterminate", "Someone is working on it."),
    ("10002", "In Review", "indeterminate", "Waiting for review."),
    ("10003", "Blocked", "indeterminate", "Can't continue until something else happens."),
    ("10004", "Done", "done", "Finished."),
    ("10005", "Canceled", "done", "Won't be done."),
]
STATUS_BY_NAME = {s[1]: s for s in STATUSES}
STATUS_BY_ID = {s[0]: s for s in STATUSES}

# Workflows: status name -> [(transition id, transition name, target status name)].
# Not everything is reachable from everywhere (e.g. To Do -> Done needs In Progress and review).
STANDARD_FLOW = {
    "Backlog": [("21", "Select for development", "To Do"), ("71", "Cancel", "Canceled")],
    "To Do": [("11", "Move to backlog", "Backlog"), ("31", "Start progress", "In Progress"), ("71", "Cancel", "Canceled")],
    "In Progress": [("21", "Stop progress", "To Do"), ("41", "Request review", "In Review"), ("51", "Block", "Blocked")],
    "In Review": [("31", "Request changes", "In Progress"), ("61", "Done", "Done")],
    "Blocked": [("31", "Unblock", "In Progress"), ("71", "Cancel", "Canceled")],
    "Done": [("81", "Reopen", "In Progress")],
    "Canceled": [("91", "Reopen", "Backlog")],
}
EPIC_FLOW = {
    "Backlog": [("21", "Select for development", "To Do"), ("71", "Cancel", "Canceled")],
    "To Do": [("11", "Move to backlog", "Backlog"), ("31", "Start progress", "In Progress"), ("71", "Cancel", "Canceled")],
    "In Progress": [("21", "Stop progress", "To Do"), ("61", "Done", "Done")],
    "Done": [("81", "Reopen", "In Progress")],
    "Canceled": [("91", "Reopen", "Backlog")],
}

PRIORITIES = [  # (id, name, color) most to least urgent
    ("1", "Highest", "#d04437"), ("2", "High", "#f15c75"), ("3", "Medium", "#f79232"),
    ("4", "Low", "#707070"), ("5", "Lowest", "#999999"),
]
PRIORITY_BY_ID = {p[0]: p for p in PRIORITIES}
PRIORITY_BY_NAME = {p[1].lower(): p for p in PRIORITIES}
DEFAULT_PRIORITY = "3"

ISSUE_TYPES = [  # (id, name, subtask, hierarchyLevel, description)
    ("10000", "Epic", False, 1, "A big user story that needs to be broken down."),
    ("10001", "Task", False, 0, "A small, distinct piece of work."),
    ("10002", "Bug", False, 0, "A problem or error."),
    ("10003", "Story", False, 0, "A user story."),
    ("10004", "Sub-task", True, -1, "A small piece of work that's part of a larger task."),
]
TYPE_BY_ID = {t[0]: t for t in ISSUE_TYPES}
TYPE_BY_NAME = {t[1].lower(): t for t in ISSUE_TYPES}

CLIENT_OPTIONS = [("10100", "Acme Corp"), ("10101", "Globex"), ("10102", "Initech"), ("10103", "Internal")]
CLIENT_BY_KEY = {"acme": "10100", "globex": "10101", "initech": "10102", "internal": "10103"}
VERSIONS = [  # (id, name, archived, released, releaseDate)
    ("10202", "2026.09", False, True, "2026-09-30"),
    ("10200", "2026.10", False, False, "2026-10-31"),
    ("10201", "2026.11", False, False, "2026-11-30"),
    ("10203", "2025.12", True, True, "2025-12-15"),
]
VERSION_BY_ID = {v[0]: v for v in VERSIONS}
VERSION_BY_NAME = {v[1]: v for v in VERSIONS}
COMPONENTS = [("10300", "Web"), ("10301", "API"), ("10302", "Mobile")]
COMPONENT_BY_ID = dict(COMPONENTS)

# ---------------------------------------------------------------------------------------------
# ADF (Atlassian Document Format) builders
# ---------------------------------------------------------------------------------------------


def _inline(c: Any) -> Dict[str, Any]:
    return {"type": "text", "text": c} if isinstance(c, str) else c


def t(text: str, *marks: Dict[str, Any]) -> Dict[str, Any]:
    node = {"type": "text", "text": text}  # type: Dict[str, Any]
    if marks:
        node["marks"] = list(marks)
    return node


STRONG = {"type": "strong"}
EM = {"type": "em"}
CODE = {"type": "code"}


def link(href: str) -> Dict[str, Any]:
    return {"type": "link", "attrs": {"href": href}}


def p(*content: Any) -> Dict[str, Any]:
    return {"type": "paragraph", "content": [_inline(c) for c in content]}


def heading(level: int, text: str) -> Dict[str, Any]:
    return {"type": "heading", "attrs": {"level": level}, "content": [t(text)]}


def _items(items: Tuple[Any, ...]) -> List[Dict[str, Any]]:
    return [{"type": "listItem", "content": [i if isinstance(i, dict) and i.get("type") == "paragraph" else p(i)]}
            for i in items]


def ul(*items: Any) -> Dict[str, Any]:
    return {"type": "bulletList", "content": _items(items)}


def ol(*items: Any) -> Dict[str, Any]:
    return {"type": "orderedList", "attrs": {"order": 1}, "content": _items(items)}


def codeblock(text: str, lang: str = "") -> Dict[str, Any]:
    node = {"type": "codeBlock", "content": [t(text)]}  # type: Dict[str, Any]
    if lang:
        node["attrs"] = {"language": lang}
    return node


def table(header: List[str], *rows: List[str]) -> Dict[str, Any]:
    def cell(kind: str, text: str) -> Dict[str, Any]:
        return {"type": kind, "attrs": {}, "content": [p(text)]}
    content = [{"type": "tableRow", "content": [cell("tableHeader", h) for h in header]}]
    content += [{"type": "tableRow", "content": [cell("tableCell", c) for c in r]} for r in rows]
    return {"type": "table", "attrs": {"isNumberColumnEnabled": False, "layout": "default"}, "content": content}


def mention(account_id: str) -> Dict[str, Any]:
    name = next(u[1] for u in USERS if u[0] == account_id)
    return {"type": "mention", "attrs": {"id": account_id, "text": "@" + name, "accessLevel": ""}}


def emoji(short_name: str, code: str, text: str) -> Dict[str, Any]:
    return {"type": "emoji", "attrs": {"shortName": short_name, "id": code, "text": text}}


def media_single(media_id: str, name: str, width: int = 1440, height: int = 900) -> Dict[str, Any]:
    return {"type": "mediaSingle", "attrs": {"layout": "center"}, "content": [
        {"type": "media", "attrs": {"type": "file", "id": media_id, "collection": "", "alt": name,
                                    "width": width, "height": height}}]}


def doc(*blocks: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "doc", "version": 1, "content": list(blocks)}


def plain_doc(*paragraphs: str) -> Dict[str, Any]:
    return doc(*[p(x) for x in paragraphs])


def adf_text(node: Any) -> str:
    """Plain text of an ADF node (for text search and changelog strings)."""
    if not isinstance(node, dict):
        return ""
    if node.get("type") == "text":
        return node.get("text", "")
    if node.get("type") == "mention":
        return (node.get("attrs") or {}).get("text", "")
    if node.get("type") == "hardBreak":
        return "\n"
    inner = "".join(adf_text(c) for c in node.get("content") or [])
    block = node.get("type") in ("paragraph", "heading", "listItem", "codeBlock", "tableRow")
    return inner + ("\n" if block else "")


# ---------------------------------------------------------------------------------------------
# Seed issues
# ---------------------------------------------------------------------------------------------

# (num, type, summary, status, assignee, priority, labels, due in days, parent num,
#  created days ago, updated hours ago, client, fix version)
SEED = [
    (1, "Epic", "Customer onboarding revamp", "In Progress", "alice", "High", ["onboarding"], 30, None, 120, 20, "acme", "2026.11"),
    (2, "Epic", "Billing v2", "To Do", "bob", "Medium", ["billing"], None, None, 110, 50, "globex", "2026.11"),
    (3, "Epic", "Mobile app performance", "Backlog", None, "Low", ["mobile", "perf"], None, None, 100, 300, "internal", "2026.11"),
    (4, "Story", "Redesign signup flow", "In Progress", "me", "High", ["onboarding", "ux"], -2, 1, 60, 3, "acme", "2026.10"),
    (5, "Task", "Write welcome email copy", "To Do", "carol", "Medium", ["copy"], 3, 1, 58, 30, "acme", "2026.10"),
    (6, "Bug", "Signup form rejects plus-addressed emails", "In Review", "me", "Highest", ["bug-bash"], 0, 1, 20, 2, "acme", "2026.10"),
    (7, "Task", "Add progress indicator to onboarding wizard", "Blocked", "me", "Medium", [], -5, 1, 40, 26, "acme", "2026.10"),
    (8, "Story", "Invoice PDF export", "In Progress", "bob", "High", ["billing"], 7, 2, 55, 5, "globex", "2026.11"),
    (9, "Task", "Migrate Stripe webhooks to the v2 API", "To Do", "me", "High", ["billing", "backend"], 1, 2, 50, 8, "globex", "2026.11"),
    (10, "Bug", "Tax rounding off by one cent on EU invoices", "To Do", "alice", "Highest", ["billing", "bug-bash"], -1, 2, 12, 6, "globex", "2026.10"),
    (11, "Task", "Proration for mid-cycle plan changes", "Backlog", None, "Medium", ["billing"], None, 2, 45, 200, "globex", "2026.11"),
    (12, "Story", "Cold start under 2 s on Android", "Backlog", "carol", "Medium", ["mobile", "perf"], None, 3, 90, 400, "internal", "2026.11"),
    (13, "Task", "Profile image cache hit rate", "Backlog", None, "Low", ["mobile"], None, 3, 88, 500, "internal", "2026.11"),
    (14, "Bug", "Crash when rotating the device on the checkout screen", "In Progress", "carol", "Highest", ["mobile", "crash"], 2, 3, 9, 4, "acme", "2026.10"),
    (15, "Task", "Set up Sentry release health", "Done", "me", "Medium", ["observability"], None, 3, 70, 240, "internal", "2026.09"),
    (16, "Task", "Update Terms of Service link in footer", "Done", "bob", "Low", [], None, None, 35, 100, "internal", "2026.09"),
    (17, "Bug", "Dark mode: unreadable table headers", "Done", "me", "Low", ["ux"], None, None, 30, 72, "initech", "2026.09"),
    (18, "Task", "Evaluate feature-flag vendors", "Canceled", "alice", "Lowest", ["research"], None, None, 80, 600, "internal", "2026.09"),
    (19, "Story", "Self-serve SSO configuration", "To Do", "me", "High", ["enterprise"], 14, None, 25, 12, "initech", "2026.11"),
    (20, "Task", "Rotate staging database credentials", "In Review", "bob", "High", ["security"], 1, None, 6, 7, "internal", "2026.10"),
    (21, "Bug", "Search returns archived projects", "In Progress", "me", "Medium", ["search"], None, None, 15, 9, "initech", "2026.10"),
    (22, "Task", "Quarterly access review", "To Do", "carol", "Medium", ["security", "compliance"], 21, None, 18, 40, "internal", "2026.11"),
    (23, "Task", "Document the release process", "Backlog", "me", "Low", ["docs"], None, None, 65, 350, "internal", "2026.11"),
    (24, "Bug", "CSV import silently drops rows with a BOM", "To Do", None, "High", ["import"], None, None, 4, 22, "globex", "2026.10"),
    (25, "Story", "Saved filters in issue search", "Backlog", "alice", "Medium", ["search"], None, None, 75, 450, "initech", "2026.11"),
    (26, "Task", "Upgrade Postgres 14 to 16", "Blocked", "bob", "High", ["backend", "infra"], -3, None, 33, 28, "internal", "2026.10"),
    (27, "Task", "Accessibility audit for settings pages", "In Review", "carol", "Medium", ["a11y"], 5, None, 22, 11, "initech", "2026.10"),
    (28, "Bug", "Timezone shown as UTC in email digests", "Done", "alice", "Medium", [], None, None, 27, 150, "acme", "2026.09"),
    (29, "Task", "Remove legacy v1 export endpoints", "Canceled", "me", "Low", ["backend"], None, None, 95, 700, "internal", "2026.09"),
    (30, "Story", "Usage-based billing dashboard", "To Do", "bob", "Medium", ["billing"], None, 2, 42, 60, "globex", "2026.11"),
    (31, "Sub-task", "Wireframes for step 2", "Done", "carol", "Medium", [], None, 4, 59, 200, None, None),
    (32, "Sub-task", "Implement email validation", "In Progress", "me", "Medium", [], 1, 4, 59, 4, None, None),
    (33, "Sub-task", "Copy review with marketing", "To Do", "alice", "Low", [], None, 4, 59, 90, None, None),
    (34, "Sub-task", "Unit tests for the webhook handler", "To Do", "me", "Medium", [], None, 9, 49, 30, None, None),
    (35, "Sub-task", "Backfill missed events", "Backlog", None, "Medium", [], None, 9, 49, 120, None, None),
    (36, "Sub-task", "Reproduce on Pixel 7", "Done", "carol", "High", [], None, 14, 8, 50, None, None),
    (37, "Sub-task", "Fix the fragment lifecycle", "In Progress", "carol", "Highest", [], None, 14, 8, 5, None, None),
    (38, "Sub-task", "Draft SAML metadata upload UI", "To Do", "me", "Medium", ["enterprise"], None, 19, 24, 13, None, None),
    (39, "Task", "Weekly dependency updates", "In Progress", "me", "Low", ["maintenance"], 4, None, 730, 1.5, "internal", "2026.10"),
    (40, "Bug", "Flaky e2e test: checkout timeout", "To Do", "bob", "Medium", ["ci", "flaky"], None, None, 3, 0.17, "internal", "2026.10"),
]
LONG_HISTORY_ISSUE = 39  # gets more changelog histories than one page (100)
COMPONENTS_OF = {4: ["10300"], 6: ["10300"], 8: ["10301"], 9: ["10301"], 14: ["10302"], 21: ["10300", "10301"]}

MEDIA = {  # issue num -> [(media uuid, attachment id, file name, mime, size)]
    4: [("6a1c2f9e-3b8d-4c7e-a0f1-2b3c4d5e6f70", "10500", "signup-step2.png", "image/png", 284113)],
    14: [("7b2d3a0f-4c9e-4d8f-b1a2-3c4d5e6f7081", "10501", "crash-rotation.mp4", "video/mp4", 5120334),
         ("8c3e4b1a-5dae-4e9a-c2b3-4d5e6f708192", "10502", "logcat.txt", "text/plain", 18234)],
}


def _descriptions() -> Dict[int, Optional[Dict[str, Any]]]:
    return {
        1: doc(
            heading(2, "Goal"),
            p("Cut time-to-first-value for new workspaces from ", t("3 days", STRONG), " to under an hour."),
            heading(3, "Milestones"),
            table(["Milestone", "Owner", "Target"],
                  ["New signup flow", "Sam Rivera", "Oct"],
                  ["Welcome emails", "Carol Schmidt", "Oct"],
                  ["In-app checklist", "Alice Nguyen", "Nov"]),
            p("Tracking doc: ", t("onboarding spec", link("https://example.com/specs/onboarding")), " ",
              emoji(":rocket:", "1f680", "\U0001F680")),
        ),
        4: doc(
            p("The current signup asks for ", t("eleven", EM), " fields before the user sees anything. "
              "Design wants three steps with progressive disclosure."),
            heading(3, "Acceptance criteria"),
            ol("Email and password on step 1 only",
               "Company name and size on step 2",
               p("Invite teammates on step 3 (skippable) ", emoji(":tada:", "1f389", "\U0001F389"))),
            heading(3, "Notes"),
            ul("Keep the existing OAuth buttons", "Track drop-off per step",
               p("Mockups by ", mention(CAROL_ID), " below")),
            media_single(MEDIA[4][0][0], MEDIA[4][0][2]),
        ),
        6: doc(
            p("Addresses like ", t("sam+test@example.com", CODE), " fail validation on the signup form."),
            heading(3, "Steps to reproduce"),
            ol("Open /signup", "Enter an address with a plus sign", "Submit"),
            p(t("Expected: ", STRONG), "account created. ", t("Actual: ", STRONG), "“Invalid email”."),
            codeblock("const EMAIL_RE = /^[a-z0-9._-]+@[a-z0-9.-]+\\.[a-z]{2,}$/i;  // no '+'", "javascript"),
            p("See ", t("RFC 5322", link("https://www.rfc-editor.org/rfc/rfc5322")), "."),
        ),
        14: doc(
            p("Rotating the phone while the payment sheet is open crashes the app on Android 14."),
            codeblock("java.lang.IllegalStateException: Fragment PaymentSheetFragment not attached to a context.\n"
                      "    at androidx.fragment.app.Fragment.requireContext(Fragment.java:972)\n"
                      "    at com.example.checkout.PaymentSheetFragment.onConfigurationChanged(PaymentSheetFragment.kt:88)",
                      "java"),
            media_single(MEDIA[14][0][0], MEDIA[14][0][2], 1080, 2400),
            p("Affects ~1.2% of checkout sessions ", emoji(":fire:", "1f525", "\U0001F525"), " cc ", mention(BOB_ID)),
        ),
        5: plain_doc("Three emails: welcome, day 2 tips, day 7 check-in.", "Tone: friendly, short. Draft in the shared doc first."),
        7: plain_doc("Show “Step 2 of 3” above the form.", "Blocked until the new signup flow lands."),
        9: plain_doc("Stripe deprecates the v1 webhook payloads in January.\nMove the handler to the v2 event objects and keep idempotency keys."),
        10: plain_doc("Invoices for EU customers are off by €0.01 when the cart has more than 3 lines.",
                      "Probably rounding per line instead of per invoice."),
        19: plain_doc("Enterprise admins should be able to upload SAML metadata and test the connection without contacting support."),
        20: plain_doc("Rotate the staging credentials and update the secrets in the deploy pipeline."),
        21: plain_doc("Archived projects show up in global search results. They should be hidden unless “include archived” is on."),
        24: plain_doc("Files exported from Excel start with a byte order mark; the first row is dropped without an error."),
        26: plain_doc("Blocked on the extension compatibility check for pg_partman."),
        39: plain_doc("Renovate opens the PRs every Monday; review, merge and deploy them."),
        40: plain_doc("Fails about 1 in 20 runs on CI with a 30 s timeout in the checkout step."),
    }


# Comments: issue num -> [(author, position between created (0) and updated (1), body, edited)]
def _comments() -> Dict[int, List[Tuple[str, float, Dict[str, Any], bool]]]:
    return {
        1: [("alice", 0.2, plain_doc("Kickoff notes are in the spec doc."), False),
            ("bob", 0.6, doc(p("Billing needs the company size from step 2 ", mention(ALICE_ID), ".")), False)],
        4: [("carol", 0.3, plain_doc("Wireframes are attached to the sub-task."), False),
            ("me", 0.7, plain_doc("Started on step 1. Step 3 might slip to next week."), False),
            ("alice", 0.9, doc(p("Looks great ", emoji(":thumbsup:", "1f44d", "\U0001F44D"), " ship step 1 behind a flag.")), False)],
        6: [("bob", 0.4, plain_doc("Same bug exists in the invite form."), False),
            ("me", 0.8, doc(p("Fixed the regex, see ", t("EMAIL_RE", CODE), " in the PR.")), False)],
        9: [("me", 0.5, plain_doc("Waiting for Stripe test keys."), False)],
        10: [("alice", 0.5, plain_doc("Reproduced with the attached cart."), False)],
        14: [("carol", 0.3, plain_doc("Reproduced on Pixel 7 and Galaxy S23."), False),
             ("bob", 0.6, plain_doc("Probably the sheet is re-created after rotation."), False),
             ("bot", 0.8, plain_doc("This issue was linked to 3 crash reports."), False)],
        15: [("bot", 0.95, plain_doc("Release health is now reported for 2026.09."), False)],
        21: [("me", 0.5, plain_doc("Root cause: the index filter ignores the archived flag."), True),
             ("alice", 0.8, plain_doc("Can we also hide archived issues?"), False)],
        26: [("bob", 0.4, plain_doc("Waiting on the vendor for pg_partman 5."), False),
             ("carol", 0.7, plain_doc("Any ETA? This blocks the reporting work."), False)],
        39: [("me", 0.99, plain_doc("This week: 14 PRs, all green."), False)],
    }


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------


def jtime(dt: datetime) -> str:
    """Jira's timestamp format: 2026-10-20T09:15:03.123+0000."""
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + "%03d+0000" % (dt.microsecond // 1000)


def changelog_day(day: Optional[str]) -> Optional[str]:
    return day + " 00:00:00.0" if day else None


def _png(width: int, height: int, seed: str) -> bytes:
    """A small valid PNG (diagonal two-colour gradient derived from ``seed``)."""
    h = hashlib.sha256(seed.encode()).digest()
    a, b = h[:3], h[3:6]
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            t = (x + y) / float(width + height)
            row += bytes(int(a[i] * (1 - t) + b[i] * t) for i in range(3))
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows))) + chunk(b"IEND", b""))


def placeholder_file(mime: str, filename: str) -> bytes:
    """Bytes for a seeded attachment (the seed only has metadata)."""
    if mime == "image/png":
        return _png(240, 150, filename)
    return ("mock file %s (%s)\n" % (filename, mime)).encode()


def parse_multipart(ctype: str, raw: bytes) -> List[Tuple[str, str, str, bytes]]:
    """multipart/form-data -> [(field name, filename, content type, bytes)]."""
    msg = BytesParser(policy=email_policy.HTTP).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
    out = []  # type: List[Tuple[str, str, str, bytes]]
    if not msg.is_multipart():
        return out
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition") or ""
        filename = part.get_filename() or ""
        out.append((str(name), str(filename), part.get_content_type(), part.get_payload(decode=True) or b""))
    return out


class ApiError(Exception):
    """An error answer in Jira's shape: {"errorMessages": [...], "errors": {...}}."""

    def __init__(self, status: int, messages: Optional[List[str]] = None,
                 errors: Optional[Dict[str, str]] = None) -> None:
        super().__init__(status, messages, errors)
        self.status = status
        self.payload = {"errorMessages": list(messages or []), "errors": dict(errors or {})}


def not_found_issue() -> ApiError:
    return ApiError(404, ["Issue does not exist or you do not have permission to see it."])


# ---------------------------------------------------------------------------------------------
# JQL
# ---------------------------------------------------------------------------------------------

TOKEN_RE = re.compile(r"""\s*(?:(?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?P<op>!=|>=|<=|!~|=|~|>|<)"""
                      r"""|(?P<punct>[(),])|(?P<word>[^\s"'(),=!<>~]+))""")
REL_RE = re.compile(r"^([-+]?)(\d+)([mhdw])$")
ABS_RE = re.compile(r"^(\d{4})[-/](\d{2})[-/](\d{2})(?: (\d{1,2}):(\d{2}))?$")
DATE_ERR = ("Date value '%s' for field '%s' is invalid. Valid formats include: 'yyyy/MM/dd HH:mm', "
            "'yyyy-MM-dd HH:mm', 'yyyy/MM/dd', 'yyyy-MM-dd', or a period format e.g. '-5d', '4w 2d'.")
ORDERABLE = ("updated", "created", "priority", "key", "duedate", "status")


class JqlError(Exception):
    pass


class Jql:
    """Parses the JQL subset jira-lite sends: AND-joined clauses plus ORDER BY.

    Fields: project, key/issuekey/id, assignee (= currentUser() / "<accountId>", is [not] EMPTY),
    status, statusCategory, issuetype/type, labels, parent, updated/created/duedate (relative
    -Nm/-Nh/-Nd/-Nw or yyyy-MM-dd [HH:mm]), text/summary/description (~ "word*").
    ``[NOT] IN (a, "b", ...)`` for parent, key, issuetype, status, labels and assignee.
    ORDER BY updated, created, priority, key, duedate, status (ASC|DESC).
    Anything else raises :class:`JqlError` (a 400 like Jira's).
    """

    def __init__(self, text: str) -> None:
        self.text = text or ""
        self.tokens = self._tokenize(self.text)
        self.pos = 0
        self.clauses = []  # type: List[Tuple[str, str, Any]]
        self.order = []  # type: List[Tuple[str, bool]]  # (field, descending)
        self._parse()

    @staticmethod
    def _tokenize(text: str) -> List[Tuple[str, str]]:
        out = []
        pos = 0
        text = text.rstrip()
        while pos < len(text):
            m = TOKEN_RE.match(text, pos)
            if not m or m.end() == pos:
                raise JqlError("Error in the JQL Query: the character '%s' is a reserved JQL character "
                               "(at character %d)." % (text[pos], pos + 1))
            kind = m.lastgroup or ""
            value = m.group(kind)
            if kind == "str":
                value = re.sub(r"\\(.)", r"\1", value[1:-1])
            out.append((kind, value))
            pos = m.end()
        return out

    def _peek(self) -> Tuple[str, str]:
        return self.tokens[self.pos] if self.pos < len(self.tokens) else ("eof", "")

    def _next(self) -> Tuple[str, str]:
        tok = self._peek()
        self.pos += 1
        return tok

    def _is_word(self, *words: str) -> bool:
        kind, value = self._peek()
        return kind == "word" and value.lower() in words

    def _parse(self) -> None:
        while self._peek()[0] != "eof":
            if self._is_word("order"):
                self._parse_order()
                break
            self.clauses.append(self._parse_clause())
            if self._is_word("and"):
                self._next()
                continue
            if self._is_word("or"):
                raise JqlError("mock_jira: OR is not supported (only AND-joined clauses).")
            if self._peek()[0] != "eof" and not self._is_word("order"):
                raise JqlError("Error in the JQL Query: Expecting either 'OR' or 'AND' but got '%s'."
                               % self._peek()[1])

    def _parse_order(self) -> None:
        self._next()
        if not self._is_word("by"):
            raise JqlError("Error in the JQL Query: Expecting 'BY' after 'ORDER'.")
        self._next()
        while True:
            kind, field = self._next()
            if kind not in ("word", "str"):
                raise JqlError("Error in the JQL Query: Expecting a field name after 'ORDER BY'.")
            field = field.lower()
            if field not in ORDERABLE:
                raise JqlError("mock_jira: can't ORDER BY '%s' (supported: %s)." % (field, ", ".join(ORDERABLE)))
            desc = False
            if self._is_word("asc", "desc"):
                desc = self._next()[1].lower() == "desc"
            self.order.append((field, desc))
            if self._peek() == ("punct", ","):
                self._next()
                continue
            if self._peek()[0] != "eof":
                raise JqlError("Error in the JQL Query: unexpected '%s' after ORDER BY." % self._peek()[1])
            return

    def _parse_clause(self) -> Tuple[str, str, Any]:
        kind, field = self._next()
        if kind not in ("word", "str") or field.lower() in ("not", "and", "or"):
            raise JqlError("mock_jira: unsupported JQL near '%s' (expected a field name)." % field)
        field = field.lower()
        kind, op = self._next()
        if kind == "word" and op.lower() == "is":
            op = "is"
            if self._is_word("not"):
                self._next()
                op = "is not"
        elif kind == "word" and op.lower() == "in":
            return field, "in", self._parse_list(field)
        elif kind == "word" and op.lower() == "not" and self._is_word("in"):
            self._next()
            return field, "not in", self._parse_list(field)
        elif kind == "word" and op.lower() in ("not", "was", "changed"):
            raise JqlError("mock_jira: operator '%s' is not supported." % op.upper())
        elif kind != "op":
            raise JqlError("Error in the JQL Query: Expecting operator but got '%s'." % op)
        kind, value = self._next()
        if kind not in ("word", "str"):
            raise JqlError("Error in the JQL Query: Expecting a value for '%s %s'." % (field, op))
        if kind == "word" and self._peek() == ("punct", "("):
            self._next()
            if self._next() != ("punct", ")"):
                raise JqlError("mock_jira: function arguments are not supported (%s)." % value)
            value = ("fn", value.lower())
        elif kind == "word" and value.lower() in ("empty", "null"):
            value = ("empty",)
        return field, op, value

    def _parse_list(self, field: str) -> Tuple[str, List[str]]:
        """The value list of ``field [NOT] IN ("a", b, ...)`` (functions such as openSprints() are not supported)."""
        if self._next() != ("punct", "("):
            raise JqlError("mock_jira: IN needs a parenthesised value list for '%s'." % field)
        values = []  # type: List[str]
        while True:
            kind, value = self._next()
            if kind not in ("word", "str"):
                raise JqlError("Error in the JQL Query: Expecting a value in the list for '%s'." % field)
            values.append(value)
            sep = self._next()
            if sep == ("punct", ")"):
                return ("list", values)
            if sep != ("punct", ","):
                raise JqlError("Error in the JQL Query: Expecting ',' or ')' in the list for '%s'." % field)


# ---------------------------------------------------------------------------------------------
# The fake Jira
# ---------------------------------------------------------------------------------------------


class MockJira:
    """In-memory Jira project with the REST behaviour jira-lite relies on. Thread-safe."""

    def __init__(self, base_url: str, project: str = PROJECT_KEY) -> None:
        self.base = base_url.rstrip("/")
        self.project = project
        self.lock = threading.RLock()
        self.index_lag = 0.0  # seconds search/jql trails the live data (see _searchable)
        self.reset()

    # ---- state ------------------------------------------------------------------------------

    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def reset(self) -> None:
        with self.lock:
            self.epoch = self.now().replace(microsecond=0)
            self.issues = {}  # type: Dict[str, Dict[str, Any]]
            self.next_issue = 1
            self.next_comment = 10000
            self.next_history = 20000
            self.next_attachment = 10600
            self._seed()
            # (visible_at, snapshot of self.issues): what search/jql sees from visible_at on.
            self._index = [(0.0, copy.deepcopy(self.issues))]  # type: List[Tuple[float, Dict[str, Dict[str, Any]]]]

    def reindex(self) -> None:
        """Queues the current data for search, visible after the index lag (call after every write)."""
        with self.lock:
            if not self.index_lag:
                return
            now = time.monotonic()
            self._index.append((now + self.index_lag, copy.deepcopy(self.issues)))
            live = [i for i, (at, _) in enumerate(self._index) if at <= now]
            del self._index[:live[-1] if live else 0]  # keep the newest visible snapshot and the queued ones

    def _searchable(self) -> Dict[str, Dict[str, Any]]:
        """The issues as the search index has them: the live data without a lag."""
        if not self.index_lag:
            return self.issues
        now = time.monotonic()
        return [snap for at, snap in self._index if at <= now][-1]

    def _seed(self) -> None:
        epoch = self.epoch
        today = epoch.date()
        descriptions = _descriptions()
        comments = _comments()
        for row in SEED:
            (num, type_name, summary, status, who, prio, labels, due, parent, created_days, updated_hours,
             client, version) = row
            if parent is not None:
                prow = SEED[parent - 1]
                client = client or prow[11]
                version = version or prow[12]
            # Later keys a little later on the same day, so siblings sort by key when ordered by created.
            created = epoch - timedelta(days=created_days, hours=6) + timedelta(minutes=num * 3)
            updated = epoch - timedelta(hours=updated_hours)
            issue = self._new_issue(num, TYPE_BY_NAME[type_name.lower()][0], summary, created)
            issue.update({
                "status": STATUS_BY_NAME[status][0],
                "priority": PRIORITY_BY_NAME[prio.lower()][0],
                "assignee": SHORT[who],
                "reporter": ALICE_ID if num % 3 == 0 else (BOB_ID if num % 3 == 1 else ME_ID),
                "labels": list(labels),
                "duedate": (today + timedelta(days=due)).isoformat() if due is not None else None,
                "parent": "%s-%d" % (self.project, parent) if parent else None,
                "description": descriptions.get(num),
                "client": CLIENT_BY_KEY[client] if client else None,
                "fixVersions": [VERSION_BY_NAME[version][0]] if version else [],
                "components": list(COMPONENTS_OF.get(num, [])),
                "updated": updated,
            })
            issue["creator"] = issue["reporter"]
            if STATUS_BY_ID[issue["status"]][2] == "done":
                issue["resolution"] = "Won't Do" if status == "Canceled" else "Done"
                issue["resolutiondate"] = updated
            for media_id, att_id, name, mime, size in MEDIA.get(num, []):
                issue["attachments"].append({"id": att_id, "filename": name, "mimeType": mime, "size": size,
                                             "author": issue["reporter"], "created": created + timedelta(minutes=20),
                                             "mediaId": media_id})
            self._seed_history(issue, who, status, prio, labels, due)
            for author, pos, body, edited in comments.get(num, []):
                at = created + (updated - created) * pos
                c = self._new_comment(SHORT[author], body, at)
                if edited:
                    c["updated"] = at + timedelta(hours=2)
                issue["comments"].append(c)
            self.issues[issue["key"]] = issue
        self.next_issue = len(SEED) + 1

    def _new_issue(self, num: int, type_id: str, summary: str, created: datetime) -> Dict[str, Any]:
        return {
            "id": str(10000 + num), "key": "%s-%d" % (self.project, num), "num": num, "type": type_id,
            "summary": summary, "status": STATUS_BY_NAME["To Do"][0], "priority": DEFAULT_PRIORITY,
            "assignee": None, "reporter": ME_ID, "creator": ME_ID, "labels": [], "duedate": None,
            "parent": None, "description": None, "client": None, "fixVersions": [], "components": [],
            "attachments": [], "comments": [], "histories": [], "created": created, "updated": created,
            "statuscategorychangedate": created, "resolution": None, "resolutiondate": None,
        }

    def _new_comment(self, author: str, body: Dict[str, Any], at: datetime) -> Dict[str, Any]:
        cid = str(self.next_comment)
        self.next_comment += 1
        return {"id": cid, "author": author, "updateAuthor": author, "body": body, "created": at, "updated": at}

    def _history(self, issue: Dict[str, Any], author: Optional[str], at: datetime,
                 items: List[Dict[str, Any]]) -> None:
        hid = str(self.next_history)
        self.next_history += 1
        issue["histories"].append({"id": hid, "author": author, "created": at, "items": items})

    def _seed_history(self, issue: Dict[str, Any], who: Optional[str], status: str, prio: str,
                      labels: List[str], due: Optional[int]) -> None:
        """Plausible past changes ending at the seeded state, spread between created and updated."""
        flow = self._flow(issue)
        start = "Backlog" if status in ("Backlog", "Canceled") or issue["type"] == "10000" and status == "Backlog" else "To Do"
        path = self._path(flow, start, status)
        actor = SHORT[who] or issue["reporter"]
        steps = []  # type: List[Tuple[Optional[str], List[Dict[str, Any]]]]
        if who:
            steps.append((issue["reporter"], [self._item("assignee", None, None, SHORT[who], self.user_name(SHORT[who]))]))
        if prio != "Medium" and issue["num"] % 2 == 0:
            p_id = PRIORITY_BY_NAME[prio.lower()][0]
            steps.append((issue["reporter"], [self._item("priority", DEFAULT_PRIORITY, "Medium", p_id, prio)]))
        if labels:
            steps.append((actor, [self._item("labels", None, "", None, " ".join(labels))]))
        if due is not None and issue["num"] != LONG_HISTORY_ISSUE:
            steps.append((actor, [self._item("duedate", None, None, issue["duedate"], changelog_day(issue["duedate"]))]))
        if issue["num"] == LONG_HISTORY_ISSUE:  # a long-running chore: the due date moves every week
            final = datetime.strptime(issue["duedate"], "%Y-%m-%d").date()
            prev = None
            for week in range(100, -1, -1):
                day = (final - timedelta(weeks=week)).isoformat()
                steps.append((BOT_ID, [self._item("duedate", prev, changelog_day(prev), day, changelog_day(day))]))
                prev = day
        for a, b in zip(path, path[1:]):
            author = BOT_ID if issue["num"] == 15 and b == "Done" else actor
            steps.append((author, [self._item("status", STATUS_BY_NAME[a][0], a, STATUS_BY_NAME[b][0], b)]))
        if issue["num"] % 5 == 0 and issue["description"] is not None:
            steps.append((actor, [self._item("description", None, "", None, adf_text(issue["description"]).strip())]))
        span = issue["updated"] - issue["created"]
        for n, (author, items) in enumerate(steps):
            at = issue["created"] + span * ((n + 1) / float(len(steps)))
            self._history(issue, author, at, items)
        if status != start:
            issue["statuscategorychangedate"] = issue["updated"]

    @staticmethod
    def _item(field: str, frm: Optional[str], frm_s: Optional[str], to: Optional[str],
              to_s: Optional[str]) -> Dict[str, Any]:
        item = {"field": field, "fieldtype": "jira", "fieldId": field, "from": frm, "fromString": frm_s,
                "to": to, "toString": to_s}
        if field == "IssueParentAssociation":
            del item["fieldId"]
        return item

    def _flow(self, issue: Dict[str, Any]) -> Dict[str, List[Tuple[str, str, str]]]:
        return EPIC_FLOW if TYPE_BY_ID[issue["type"]][3] == 1 else STANDARD_FLOW

    @staticmethod
    def _path(flow: Dict[str, List[Tuple[str, str, str]]], start: str, goal: str) -> List[str]:
        prev = {start: None}  # type: Dict[str, Optional[str]]
        queue = [start]
        while queue:
            cur = queue.pop(0)
            if cur == goal:
                break
            for _, _, nxt in flow.get(cur, []):
                if nxt not in prev:
                    prev[nxt] = cur
                    queue.append(nxt)
        if goal not in prev:
            return [start]
        out = [goal]
        while prev[out[-1]] is not None:
            out.append(prev[out[-1]])  # type: ignore
        return out[::-1]

    # ---- JSON shapes ------------------------------------------------------------------------

    def user_name(self, account_id: Optional[str]) -> Optional[str]:
        return next((u[1] for u in USERS if u[0] == account_id), None)

    def user_json(self, account_id: Optional[str], email: bool = False) -> Optional[Dict[str, Any]]:
        u = next((x for x in USERS if x[0] == account_id), None)
        if u is None:
            return None
        av = "https://avatar-management.example.invalid/%s" % u[0].split(":")[-1]
        out = {
            "self": "%s/rest/api/3/user?accountId=%s" % (self.base, u[0]), "accountId": u[0],
            "accountType": u[2],
            "avatarUrls": {s: "%s/%s.png" % (av, s) for s in ("48x48", "24x24", "16x16", "32x32")},
            "displayName": u[1], "active": True, "timeZone": "Asia/Singapore",
        }  # type: Dict[str, Any]
        if email and u[3]:
            out["emailAddress"] = u[3]
            out["locale"] = "en_US"
        return out

    def status_json(self, status_id: str) -> Dict[str, Any]:
        sid, name, cat, desc = STATUS_BY_ID[status_id]
        category = dict(CATEGORIES[cat])
        category["self"] = "%s/rest/api/3/statuscategory/%d" % (self.base, category["id"])
        return {"self": "%s/rest/api/3/status/%s" % (self.base, sid), "description": desc,
                "iconUrl": "%s/images/icons/statuses/generic.png" % self.base, "name": name,
                "untranslatedName": name, "id": sid, "statusCategory": category}

    def priority_json(self, pid: Optional[str], full: bool = False) -> Optional[Dict[str, Any]]:
        if pid is None:
            return None
        pid, name, color = PRIORITY_BY_ID[pid]
        out = {"self": "%s/rest/api/3/priority/%s" % (self.base, pid),
               "iconUrl": "%s/images/icons/priorities/%s.svg" % (self.base, name.lower()), "name": name, "id": pid}
        if full:
            out.update({"statusColor": color, "description": name + " priority"})
        return out

    def type_json(self, type_id: str) -> Dict[str, Any]:
        tid, name, subtask, level, desc = TYPE_BY_ID[type_id]
        return {"self": "%s/rest/api/3/issuetype/%s" % (self.base, tid), "id": tid, "description": desc,
                "iconUrl": "%s/rest/api/2/universal_avatar/view/type/issuetype/avatar/%s" % (self.base, tid),
                "name": name, "untranslatedName": name, "subtask": subtask, "avatarId": 10300 + int(tid) % 100,
                "hierarchyLevel": level}

    def project_json(self) -> Dict[str, Any]:
        return {"self": "%s/rest/api/3/project/%s" % (self.base, PROJECT_ID), "id": PROJECT_ID, "key": self.project,
                "name": "Demo Project", "projectTypeKey": "software", "simplified": False,
                "avatarUrls": {"48x48": "%s/secure/projectavatar?pid=%s" % (self.base, PROJECT_ID)}}

    def client_json(self, option_id: Optional[str]) -> Optional[Dict[str, Any]]:
        if option_id is None:
            return None
        name = dict(CLIENT_OPTIONS)[option_id]
        return {"self": "%s/rest/api/3/customFieldOption/%s" % (self.base, option_id), "value": name, "id": option_id}

    def version_json(self, vid: str) -> Dict[str, Any]:
        vid, name, archived, released, date = VERSION_BY_ID[vid]
        return {"self": "%s/rest/api/3/version/%s" % (self.base, vid), "id": vid, "description": "",
                "name": name, "archived": archived, "released": released, "releaseDate": date,
                "projectId": int(PROJECT_ID)}

    def component_json(self, cid: str) -> Dict[str, Any]:
        return {"self": "%s/rest/api/3/component/%s" % (self.base, cid), "id": cid, "name": COMPONENT_BY_ID[cid]}

    def issue_ref(self, issue: Dict[str, Any]) -> Dict[str, Any]:
        """The compact form Jira uses for parent and subtasks."""
        return {"id": issue["id"], "key": issue["key"], "self": self.issue_self(issue),
                "fields": {"summary": issue["summary"], "status": self.status_json(issue["status"]),
                           "priority": self.priority_json(issue["priority"]),
                           "issuetype": self.type_json(issue["type"])}}

    def issue_self(self, issue: Dict[str, Any]) -> str:
        return "%s/rest/api/3/issue/%s" % (self.base, issue["id"])

    def comment_json(self, issue: Dict[str, Any], c: Dict[str, Any]) -> Dict[str, Any]:
        return {"self": "%s/comment/%s" % (self.issue_self(issue), c["id"]), "id": c["id"],
                "author": self.user_json(c["author"]), "body": copy.deepcopy(c["body"]),
                "updateAuthor": self.user_json(c["updateAuthor"]), "created": jtime(c["created"]),
                "updated": jtime(c["updated"]), "jsdPublic": True}

    def attachment_json(self, a: Dict[str, Any]) -> Dict[str, Any]:
        return {"self": "%s/rest/api/3/attachment/%s" % (self.base, a["id"]), "id": a["id"],
                "filename": a["filename"], "author": self.user_json(a["author"]), "created": jtime(a["created"]),
                "size": a["size"], "mimeType": a["mimeType"],
                "content": "%s/rest/api/3/attachment/content/%s" % (self.base, a["id"]),
                "thumbnail": "%s/rest/api/3/attachment/thumbnail/%s" % (self.base, a["id"])}

    def history_json(self, h: Dict[str, Any]) -> Dict[str, Any]:
        return {"id": h["id"], "author": self.user_json(h["author"]), "created": jtime(h["created"]),
                "items": copy.deepcopy(h["items"])}

    def all_fields(self, issue: Dict[str, Any]) -> Dict[str, Any]:
        parent = self.issues.get(issue["parent"]) if issue["parent"] else None
        subs = sorted((i for i in self.issues.values() if i["parent"] == issue["key"] and TYPE_BY_ID[i["type"]][2]),
                      key=lambda i: i["num"])
        return {
            "summary": issue["summary"],
            "status": self.status_json(issue["status"]),
            "priority": self.priority_json(issue["priority"]),
            "assignee": self.user_json(issue["assignee"]),
            "reporter": self.user_json(issue["reporter"]),
            "creator": self.user_json(issue["creator"]),
            "issuetype": self.type_json(issue["type"]),
            "project": self.project_json(),
            "created": jtime(issue["created"]),
            "updated": jtime(issue["updated"]),
            "statuscategorychangedate": jtime(issue["statuscategorychangedate"]),
            "duedate": issue["duedate"],
            "labels": list(issue["labels"]),
            "parent": self.issue_ref(parent) if parent else None,
            "subtasks": [self.issue_ref(s) for s in subs],
            "description": copy.deepcopy(issue["description"]),
            "fixVersions": [self.version_json(v) for v in issue["fixVersions"]],
            "components": [self.component_json(c) for c in issue["components"]],
            CLIENT_FIELD: self.client_json(issue["client"]),
            "attachment": [self.attachment_json(a) for a in issue["attachments"]],
            "resolution": ({"self": "%s/rest/api/3/resolution/1" % self.base, "id": "1" if issue["resolution"] == "Done" else "2",
                            "name": issue["resolution"], "description": ""} if issue["resolution"] else None),
            "resolutiondate": jtime(issue["resolutiondate"]) if issue["resolutiondate"] else None,
            "issuelinks": [],
            "environment": None,
            "comment": {"comments": [self.comment_json(issue, c) for c in issue["comments"]],
                        "self": self.issue_self(issue) + "/comment", "maxResults": len(issue["comments"]),
                        "total": len(issue["comments"]), "startAt": 0},
        }

    def issue_json(self, issue: Dict[str, Any], fields: Optional[List[str]] = None,
                   expand: Tuple[str, ...] = ()) -> Dict[str, Any]:
        """``fields`` None means all; Jira silently ignores unknown field ids."""
        everything = self.all_fields(issue)
        if everything["parent"] is None:
            del everything["parent"]
        wanted = everything if fields is None or "*all" in fields or "*navigable" in fields else {
            f: everything[f] for f in fields if f in everything}
        out = {"expand": "renderedFields,names,schema,operations,editmeta,changelog,versionedRepresentations",
               "id": issue["id"], "self": self.issue_self(issue), "key": issue["key"], "fields": wanted}
        if "changelog" in expand:
            newest = list(reversed(issue["histories"]))[:CHANGELOG_PAGE]
            out["changelog"] = {"startAt": 0, "maxResults": len(newest), "total": len(issue["histories"]),
                                "histories": [self.history_json(h) for h in newest]}
        return out

    # ---- lookups ----------------------------------------------------------------------------

    def find_issue(self, ref: str) -> Dict[str, Any]:
        ref = unquote(ref)
        issue = self.issues.get(ref.upper()) or next((i for i in self.issues.values() if i["id"] == ref), None)
        if issue is None:
            raise not_found_issue()
        return issue

    def _check_project(self, ref: str) -> None:
        if unquote(ref).upper() not in (self.project, PROJECT_ID):
            raise ApiError(404, ["No project could be found with key '%s'." % unquote(ref)])

    def _assignable(self) -> List[str]:
        return [u[0] for u in USERS]

    # ---- routing ----------------------------------------------------------------------------

    def dispatch(self, method: str, path: str, query: Dict[str, List[str]], body: Any) -> Tuple[int, Any]:
        """Returns (status, JSON payload or None for an empty body). Raises ApiError."""
        rest = path[len(API):]
        q = {k: v[-1] for k, v in query.items()}
        for verb, pattern, fn in self.routes():
            m = re.match(pattern + "$", rest)
            if m and verb == method:
                with self.lock:
                    out = fn(*[unquote(g) for g in m.groups()], q=q, body=body)
                    if method != "GET" and pattern != r"search/jql":
                        self.reindex()
                    return out
        if any(re.match(pattern + "$", rest) for _, pattern, _ in self.routes()):
            raise ApiError(405, ["mock_jira: method %s is not supported for %s" % (method, path)])
        raise ApiError(404, ["mock_jira: no route for %s %s" % (method, path)])

    def routes(self) -> List[Tuple[str, str, Callable[..., Tuple[int, Any]]]]:
        return [
            ("GET", r"myself", self.get_myself),
            ("GET", r"serverInfo", self.get_server_info),
            ("GET", r"priority", self.get_priorities),
            ("GET", r"priority/search", self.search_priorities),
            ("GET", r"project/([^/]+)", self.get_project),
            ("GET", r"project/([^/]+)/statuses", self.get_project_statuses),
            ("GET", r"user/assignable/search", self.get_assignable),
            ("GET", r"issue/createmeta/([^/]+)/issuetypes", self.get_createmeta_types),
            ("GET", r"issue/createmeta/([^/]+)/issuetypes/([^/]+)", self.get_createmeta_fields),
            ("POST", r"search/jql", self.search),
            ("GET", r"search/jql", self.search),
            ("POST", r"issue", self.create_issue),
            ("GET", r"issue/([^/]+)", self.get_issue),
            ("PUT", r"issue/([^/]+)", self.edit_issue),
            ("DELETE", r"issue/([^/]+)", self.delete_issue),
            ("PUT", r"issue/([^/]+)/assignee", self.assign),
            ("GET", r"issue/([^/]+)/changelog", self.get_changelog),
            ("GET", r"issue/([^/]+)/editmeta", self.get_editmeta),
            ("GET", r"issue/([^/]+)/transitions", self.get_transitions),
            ("POST", r"issue/([^/]+)/transitions", self.do_transition),
            ("GET", r"issue/([^/]+)/comment", self.get_comments),
            ("POST", r"issue/([^/]+)/comment", self.add_comment),
            ("GET", r"issue/([^/]+)/comment/([^/]+)", self.get_comment),
            ("PUT", r"issue/([^/]+)/comment/([^/]+)", self.update_comment),
            ("DELETE", r"issue/([^/]+)/comment/([^/]+)", self.delete_comment),
        ]

    # ---- metadata ---------------------------------------------------------------------------

    def get_myself(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        me = self.user_json(ME_ID, email=True)
        me["groups"] = {"size": 2, "items": []}
        me["applicationRoles"] = {"size": 1, "items": []}
        return 200, me

    def get_server_info(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        return 200, {"baseUrl": self.base, "version": "1001.0.0-SNAPSHOT", "deploymentType": "Cloud",
                     "serverTitle": "Mock Jira", "serverTime": jtime(self.now())}

    def get_priorities(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        return 200, [self.priority_json(pid, full=True) for pid, _, _ in PRIORITIES]

    def search_priorities(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        values = [self.priority_json(pid, full=True) for pid, _, _ in PRIORITIES]
        return 200, {"self": self.base + "/rest/api/3/priority/search", "maxResults": 50, "startAt": 0,
                     "total": len(values), "isLast": True, "values": values}

    def get_project(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        self._check_project(ref)
        out = self.project_json()
        out["issueTypes"] = [self.type_json(t[0]) for t in ISSUE_TYPES]
        return 200, out

    def get_project_statuses(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        self._check_project(ref)
        out = []
        for t in ISSUE_TYPES:
            flow = EPIC_FLOW if t[3] == 1 else STANDARD_FLOW
            out.append({"self": "%s/rest/api/3/issuetype/%s" % (self.base, t[0]), "id": t[0], "name": t[1],
                        "subtask": t[2], "statuses": [self.status_json(s[0]) for s in STATUSES if s[1] in flow]})
        return 200, out

    def get_assignable(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if not (q.get("project") or q.get("issueKey") or q.get("issueId")):
            raise ApiError(400, ["At least one of the parameters project, issueKey or issueId is required."])
        if q.get("project"):
            self._check_project(q["project"])
        needle = (q.get("query") or "").lower()
        users = [self.user_json(a) for a in self._assignable()]
        users = [u for u in users if not needle or needle in u["displayName"].lower()]
        start = int(q.get("startAt") or 0)
        limit = int(q.get("maxResults") or 50)
        return 200, users[start:start + limit]

    def get_createmeta_types(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        self._check_project(ref)
        types = [self.type_json(t[0]) for t in ISSUE_TYPES]
        return 200, {"maxResults": 50, "startAt": 0, "total": len(types), "issueTypes": types}

    def create_fields(self, type_id: str) -> List[Dict[str, Any]]:
        """The create screen of an issue type, in createmeta's shape."""
        _, _, subtask, level, _ = TYPE_BY_ID[type_id]

        def field(fid: str, name: str, required: bool, schema: Dict[str, Any], key: Optional[str] = None,
                  default: bool = False, ops: Tuple[str, ...] = ("set",), allowed: Optional[List[Any]] = None,
                  **extra: Any) -> Dict[str, Any]:
            f = {"required": required, "schema": schema, "name": name, "key": key or fid, "hasDefaultValue": default,
                 "operations": list(ops), "fieldId": fid}  # type: Dict[str, Any]
            if allowed is not None:
                f["allowedValues"] = allowed
            f.update(extra)
            return f

        fields = [
            field("summary", "Summary", True, {"type": "string", "system": "summary"}),
            field("issuetype", "Issue Type", True, {"type": "issuetype", "system": "issuetype"},
                  allowed=[self.type_json(type_id)]),
            field("project", "Project", True, {"type": "project", "system": "project"},
                  allowed=[self.project_json()]),
            field("reporter", "Reporter", True, {"type": "user", "system": "reporter"}, default=True,
                  autoCompleteUrl=self.base + "/rest/api/3/user/recommend?context=Reporter&issueKey="),
            field("description", "Description", False, {"type": "string", "system": "description"}),
            field("priority", "Priority", False, {"type": "priority", "system": "priority"}, default=True,
                  allowed=[self.priority_json(pid) for pid, _, _ in PRIORITIES],
                  defaultValue=self.priority_json(DEFAULT_PRIORITY)),
            field("assignee", "Assignee", False, {"type": "user", "system": "assignee"},
                  autoCompleteUrl=self.base + "/rest/api/3/user/assignable/search?project=%s&query=" % self.project),
            field("labels", "Labels", False, {"type": "array", "items": "string", "system": "labels"},
                  ops=("add", "set", "remove"),
                  autoCompleteUrl=self.base + "/rest/api/1.0/labels/suggest?query="),
            field("duedate", "Due date", False, {"type": "date", "system": "duedate"}),
            field("components", "Components", False, {"type": "array", "items": "component", "system": "components"},
                  ops=("add", "set", "remove"), allowed=[self.component_json(c) for c, _ in COMPONENTS]),
            field(CLIENT_FIELD, "Client", True,
                  {"type": "option", "custom": "com.atlassian.jira.plugin.system.customfieldtypes:select",
                   "customId": 10050}, key=CLIENT_FIELD,
                  allowed=[self.client_json(o) for o, _ in CLIENT_OPTIONS]),
            field("fixVersions", "Fix versions", True, {"type": "array", "items": "version", "system": "fixVersions"},
                  ops=("set", "add", "remove"), allowed=[self.version_json(v[0]) for v in VERSIONS]),
        ]
        if subtask or level == 0:
            fields.append(field("parent", "Parent", bool(subtask), {"type": "issuelink", "system": "parent"}))
        return fields

    def get_createmeta_fields(self, ref: str, type_id: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        self._check_project(ref)
        if type_id not in TYPE_BY_ID:
            raise ApiError(404, ["Issue type with id '%s' does not exist or is not in project." % type_id])
        fields = self.create_fields(type_id)
        start = int(q.get("startAt") or 0)
        limit = min(int(q.get("maxResults") or 50), 200)
        page = fields[start:start + limit]
        return 200, {"maxResults": limit, "startAt": start, "total": len(fields), "fields": page}

    # ---- search -----------------------------------------------------------------------------

    def search(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if isinstance(body, dict):
            jql_text = body.get("jql") or ""
            fields = body.get("fields")
            max_results = body.get("maxResults")
            token = body.get("nextPageToken")
            expand = body.get("expand") or ""
        else:
            jql_text = q.get("jql", "")
            fields = q["fields"].split(",") if q.get("fields") else None
            max_results = q.get("maxResults")
            token = q.get("nextPageToken")
            expand = q.get("expand", "")
        try:
            jql = Jql(jql_text)
        except JqlError as e:
            raise ApiError(400, [str(e)])
        if not jql.clauses:
            raise ApiError(400, ["Unbounded JQL queries are not allowed here. Please add a search restriction to your query."])
        live = self.issues
        self.issues = self._searchable()  # predicates and issue_json read self.issues; restored below
        try:
            return self._search(jql, jql_text, fields, max_results, token, expand)
        finally:
            self.issues = live

    def _search(self, jql: "Jql", jql_text: str, fields: Any, max_results: Any, token: Any, expand: Any) -> Tuple[int, Any]:
        match = self._predicate(jql)
        hits = [i for i in self.issues.values() if match(i)]
        hits = self._sorted(hits, jql.order)
        size = MAX_PAGE if max_results in (None, "") else max(1, min(int(max_results), MAX_PAGE))
        digest = hashlib.sha1(jql_text.encode()).hexdigest()[:12]
        offset = 0
        if token:
            try:
                data = json.loads(base64.urlsafe_b64decode(token.encode()).decode())
                assert data["q"] == digest
                offset = int(data["o"])
            except Exception:
                raise ApiError(400, ["The provided next page token is invalid or expired."])
        if isinstance(fields, str):
            fields = fields.split(",")
        page = hits[offset:offset + size]
        if fields is None:
            fields = ["id"]
        if isinstance(expand, list):
            expand = ",".join(expand)
        out = {"issues": [self.issue_json(i, fields, tuple(expand.split(","))) for i in page]}  # type: Dict[str, Any]
        if offset + size < len(hits):
            raw = json.dumps({"q": digest, "o": offset + size}).encode()
            out["nextPageToken"] = base64.urlsafe_b64encode(raw).decode()
            out["isLast"] = False
        else:
            out["isLast"] = True
        return 200, out

    def _relative_or_absolute(self, field: str, value: str) -> datetime:
        m = REL_RE.match(value.strip())
        if m:
            sign, n, unit = m.groups()
            delta = timedelta(**{{"m": "minutes", "h": "hours", "d": "days", "w": "weeks"}[unit]: int(n)})
            return self.now() + (delta if sign == "+" else -delta)
        m = ABS_RE.match(value.strip())
        if m:
            y, mo, d, hh, mm = m.groups()
            return datetime(int(y), int(mo), int(d), int(hh or 0), int(mm or 0), tzinfo=timezone.utc)
        raise ApiError(400, [DATE_ERR % (value, field)])

    def _predicate(self, jql: Jql) -> Callable[[Dict[str, Any]], bool]:
        tests = [self._clause(field, op, value) for field, op, value in jql.clauses]
        return lambda issue: all(test(issue) for test in tests)

    def _clause(self, field: str, op: str, value: Any) -> Callable[[Dict[str, Any]], bool]:
        def unsupported() -> ApiError:
            return ApiError(400, ["The operator '%s' is not supported by the '%s' field." % (op, field)])

        def eq(get: Callable[[Dict[str, Any]], Any], want: Any) -> Callable[[Dict[str, Any]], bool]:
            if op == "=":
                return lambda i: get(i) == want
            if op == "!=":
                return lambda i: get(i) != want
            raise unsupported()

        if op in ("in", "not in"):  # `field in (a, b)` is `field = a OR field = b`
            if field not in ("parent", "key", "issuekey", "id", "issuetype", "type", "status", "labels", "assignee"):
                raise unsupported()
            each = [self._clause(field, "=", v) for v in value[1]]
            if op == "in":
                return lambda i: any(test(i) for test in each)
            return lambda i: not any(test(i) for test in each)

        is_fn = isinstance(value, tuple) and value[0] == "fn"
        is_empty = isinstance(value, tuple) and value[0] == "empty"
        if is_fn and not (field == "assignee" and value[1] == "currentuser"):
            raise ApiError(400, ["mock_jira: function %s() is not supported for '%s'." % (value[1], field)])
        if is_empty and field not in ("assignee", "duedate", "parent", "labels"):
            raise ApiError(400, ["mock_jira: EMPTY is not supported for '%s'." % field])
        if is_empty:
            getters = {"assignee": lambda i: i["assignee"], "duedate": lambda i: i["duedate"],
                       "parent": lambda i: i["parent"], "labels": lambda i: i["labels"] or None}
            get = getters[field]
            if op in ("is", "="):
                return lambda i: get(i) is None
            if op in ("is not", "!="):
                return lambda i: get(i) is not None
            raise unsupported()
        if op in ("is", "is not"):
            raise ApiError(400, ["Error in the JQL Query: the operator '%s' needs EMPTY or NULL." % op.upper()])

        if field == "project":
            if value.upper() not in (self.project, PROJECT_ID) and value != "Demo Project":
                raise ApiError(400, ["The value '%s' does not exist for the field 'project'." % value])
            return eq(lambda i: True, True)
        if field in ("key", "issuekey", "id"):
            target = next((i for i in self.issues.values() if value.upper() in (i["key"], i["id"])), None)
            if target is None:
                if re.match(r"^[A-Za-z][A-Za-z0-9]*-\d+$", value) and value.split("-")[0].upper() == self.project:
                    raise ApiError(400, ["An issue with key '%s' does not exist for field 'key'." % value])
                raise ApiError(400, ["The issue key '%s' for field 'key' is invalid." % value])
            return eq(lambda i: i["key"], target["key"])
        if field == "assignee":
            want = ME_ID if is_fn else value
            if want not in self._assignable():
                match = next((u[0] for u in USERS if u[1].lower() == str(want).lower()), None)
                if match is None:
                    raise ApiError(400, ["The value '%s' does not exist for the field 'assignee'." % value])
                want = match
            return eq(lambda i: i["assignee"], want)
        if field == "status":
            s = STATUS_BY_NAME.get(value) or STATUS_BY_ID.get(value) or next(
                (x for x in STATUSES if x[1].lower() == value.lower()), None)
            if s is None:
                raise ApiError(400, ["The value '%s' does not exist for the field 'status'." % value])
            return eq(lambda i: i["status"], s[0])
        if field == "statuscategory":
            cat = next((k for k, c in CATEGORIES.items()
                        if value.lower() in (k, c["name"].lower(), str(c["id"]))), None)
            if cat is None:
                raise ApiError(400, ["The value '%s' does not exist for the field 'statusCategory'." % value])
            return eq(lambda i: STATUS_BY_ID[i["status"]][2], cat)
        if field in ("issuetype", "type"):
            tt = TYPE_BY_ID.get(value) or TYPE_BY_NAME.get(value.lower())
            if tt is None:
                raise ApiError(400, ["The value '%s' does not exist for the field 'issuetype'." % value])
            return eq(lambda i: i["type"], tt[0])
        if field == "labels":
            if op == "=":
                return lambda i: value in i["labels"]
            if op == "!=":
                return lambda i: value not in i["labels"]
            raise unsupported()
        if field == "parent":
            target = next((i for i in self.issues.values() if value.upper() in (i["key"], i["id"])), None)
            if target is None:
                raise ApiError(400, ["The value '%s' does not exist for the field 'parent'." % value])
            return eq(lambda i: i["parent"], target["key"])
        if field in ("updated", "created", "duedate"):
            when = self._relative_or_absolute(field, value)
            if field == "duedate":
                day = when.date().isoformat()
                get = lambda i: i["duedate"]  # noqa: E731
                limit = day  # type: Any
            else:
                get = lambda i: i[field]  # noqa: E731
                limit = when
            cmp = {">=": lambda a, b: a >= b, ">": lambda a, b: a > b, "<=": lambda a, b: a <= b,
                   "<": lambda a, b: a < b, "=": lambda a, b: a == b, "!=": lambda a, b: a != b}.get(op)
            if cmp is None:
                raise unsupported()
            return lambda i: get(i) is not None and cmp(get(i), limit)
        if field in ("text", "summary", "description", "comment"):
            if op not in ("~", "!~"):
                raise unsupported()
            if value[:1] in ("*", "?"):
                raise ApiError(400, ["The '*' and '?' are not allowed as first character in a 'wildcard' search."])
            terms = [w for w in re.split(r"[^\w*]+", value.lower()) if w.strip("*")]
            if not terms:
                raise ApiError(400, ["The field '%s' does not support searching for an empty string." % field])

            def words(i: Dict[str, Any]) -> List[str]:
                parts = []
                if field in ("text", "summary"):
                    parts.append(i["summary"])
                if field in ("text", "description"):
                    parts.append(adf_text(i["description"]))
                if field in ("text", "comment"):
                    parts.extend(adf_text(c["body"]) for c in i["comments"])
                return re.findall(r"\w+", " ".join(parts).lower())

            def hit(i: Dict[str, Any]) -> bool:
                ws = words(i)
                return all(any(w.startswith(term.rstrip("*")) if term.endswith("*") else w == term for w in ws)
                           for term in terms)
            return hit if op == "~" else (lambda i: not hit(i))
        raise ApiError(400, ["Field '%s' does not exist or you do not have permission to view it." % field])

    def _sorted(self, issues: List[Dict[str, Any]], order: List[Tuple[str, bool]]) -> List[Dict[str, Any]]:
        out = sorted(issues, key=lambda i: -i["num"])  # Jira's default: newest key first
        keys = {
            "updated": lambda i: i["updated"], "created": lambda i: i["created"],
            # Jira sorts priority by importance: DESC lists Highest first.
            "priority": lambda i: -int(i["priority"]) if i["priority"] else None,
            "key": lambda i: i["num"], "duedate": lambda i: i["duedate"],
            "status": lambda i: [s[0] for s in STATUSES].index(i["status"]),
        }
        for field, desc in reversed(order):
            get = keys[field]
            present = [i for i in out if get(i) is not None]
            missing = [i for i in out if get(i) is None]
            out = sorted(present, key=get, reverse=desc) + missing  # empty values last either way
        return out

    # ---- issues -----------------------------------------------------------------------------

    @staticmethod
    def _field_list(q: Dict[str, str]) -> Optional[List[str]]:
        raw = q.get("fields")
        return [f.strip() for f in raw.split(",") if f.strip()] if raw else None

    def get_issue(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        expand = tuple(x.strip() for x in (q.get("expand") or "").split(","))
        return 200, self.issue_json(issue, self._field_list(q), expand)

    def get_changelog(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        start = int(q.get("startAt") or 0)
        limit = min(int(q.get("maxResults") or 100), 100)
        values = issue["histories"][start:start + limit]
        return 200, {"self": self.issue_self(issue) + "/changelog", "maxResults": limit, "startAt": start,
                     "total": len(issue["histories"]), "isLast": start + limit >= len(issue["histories"]),
                     "values": [self.history_json(h) for h in values]}

    def get_editmeta(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        """The edit screen: the create screen minus project/parent; issue types of the same kind."""
        issue = self.find_issue(ref)
        _, _, subtask, level, _ = TYPE_BY_ID[issue["type"]]
        # Types the PUT accepts: same kind; another hierarchy level only without parent or children.
        tied = bool(issue["parent"]) or any(i["parent"] == issue["key"] for i in self.issues.values())
        fields = {}  # type: Dict[str, Any]
        for f in self.create_fields(issue["type"]):
            fid = f["fieldId"]
            if fid in ("project", "parent"):
                continue
            m = {k: copy.deepcopy(f[k]) for k in ("required", "schema", "name", "key", "operations", "allowedValues") if k in f}
            if fid == "issuetype":  # like Jira: listed with no operations, yet settable through PUT
                m["operations"] = []
                m["allowedValues"] = [self.type_json(t[0]) for t in ISSUE_TYPES if t[2] == subtask and (t[3] == level or not tied)]
            fields[fid] = m
        return 200, {"fields": fields}

    def _validate_fields(self, fields: Dict[str, Any], issue_type: str, creating: bool,
                         issue: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], Dict[str, str]]:
        """Checks field values like Jira does. Returns (normalised changes, errors)."""
        changes = {}  # type: Dict[str, Any]
        errors = {}  # type: Dict[str, str]
        # A type change in the same request: the other fields are checked against the new type.
        check_type = issue_type
        if not creating and isinstance(fields.get("issuetype"), dict):
            new = TYPE_BY_ID.get(str(fields["issuetype"].get("id")))
            if new is not None and new[2] == TYPE_BY_ID[issue_type][2]:
                check_type = new[0]
        on_screen = {f["fieldId"] for f in self.create_fields(check_type)}
        for fid, value in fields.items():
            if fid in ("project", "issuetype") and creating:
                continue
            if fid not in on_screen or (fid == "project" and not creating):
                errors[fid] = "Field '%s' cannot be set. It is not on the appropriate screen, or unknown." % fid
            elif fid == "issuetype":
                tt = TYPE_BY_ID.get(str(value.get("id"))) if isinstance(value, dict) else None
                cur = TYPE_BY_ID[issue_type]
                has_children = issue is not None and any(i["parent"] == issue["key"] for i in self.issues.values())
                if tt is None:
                    errors[fid] = "The issue type selected is invalid."
                elif tt[2] != cur[2]:
                    errors[fid] = "Sub-task and standard issue types can't be swapped here; use Move in Jira."
                elif tt[3] != cur[3] and issue is not None and (issue["parent"] or has_children):
                    errors[fid] = "Given parent work item does not belong to appropriate hierarchy."
                else:
                    changes["type"] = tt[0]
            elif fid == "summary":
                if not isinstance(value, str) or not value.strip():
                    errors[fid] = "You must specify a summary of the issue."
                elif len(value) > 255:
                    errors[fid] = "Summary must be less than 255 characters."
                elif "\n" in value:
                    errors[fid] = "The summary is invalid because it contains newline characters."
                else:
                    changes[fid] = value
            elif fid == "description":
                if value is None:
                    changes[fid] = None
                elif not (isinstance(value, dict) and value.get("type") == "doc" and isinstance(value.get("content"), list)):
                    errors[fid] = "Operation value must be an Atlassian Document (see the Atlassian Document Format)"
                else:
                    changes[fid] = value
            elif fid == "priority":
                pid = self._ref_id(value, PRIORITY_BY_ID, {k: v[0] for k, v in PRIORITY_BY_NAME.items()})
                if value is not None and pid is None:
                    errors[fid] = "Specify the Priority (id or name) in the correct format"
                else:
                    changes[fid] = pid
            elif fid == "assignee":
                acc = value.get("accountId") if isinstance(value, dict) else None if value is None else "?"
                if acc is not None and acc not in self._assignable():
                    errors[fid] = "User '%s' cannot be assigned issues." % acc
                else:
                    changes[fid] = acc
            elif fid == "reporter":
                acc = value.get("accountId") if isinstance(value, dict) else None
                if acc not in [u[0] for u in USERS]:
                    errors[fid] = "Specify a valid value for reporter"
                else:
                    changes[fid] = acc
            elif fid == "labels":
                if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
                    errors[fid] = "data was not an array"
                elif any(re.search(r"\s", x) or not x for x in value):
                    bad = next(x for x in value if re.search(r"\s", x) or not x)
                    errors[fid] = "The label '%s' contains spaces which is invalid." % bad
                elif any(len(x) > 255 for x in value):
                    errors[fid] = "The label must not exceed 255 characters."
                else:
                    changes[fid] = list(dict.fromkeys(value))
            elif fid == "duedate":
                if value is None:
                    changes[fid] = None
                else:
                    try:
                        changes[fid] = datetime.strptime(str(value), "%Y-%m-%d").date().isoformat()
                    except ValueError:
                        errors[fid] = "Error parsing date string: %s" % value
            elif fid == "parent":
                if value is None:
                    if TYPE_BY_ID[check_type][2]:
                        errors[fid] = "A sub-task must have a parent."
                    else:
                        changes[fid] = None
                    continue
                ref = value.get("key") or value.get("id") if isinstance(value, dict) else None
                target = None
                if ref:
                    target = self.issues.get(str(ref).upper()) or next(
                        (i for i in self.issues.values() if i["id"] == str(ref)), None)
                if target is None:
                    errors[fid] = "Could not find issue by id or key."
                    continue
                child_level = TYPE_BY_ID[check_type][3]
                parent_level = TYPE_BY_ID[target["type"]][3]
                if parent_level != child_level + 1 or (issue is not None and target["key"] == issue["key"]):
                    errors[fid] = "Given parent work item does not belong to appropriate hierarchy."
                else:
                    changes[fid] = target["key"]
            elif fid == CLIENT_FIELD:
                oid = self._ref_id(value, dict(CLIENT_OPTIONS), {n: o for o, n in CLIENT_OPTIONS}, name_key="value")
                if value is not None and oid is None:
                    errors[fid] = "Option id '%s' is not valid" % (value.get("id") if isinstance(value, dict) else value)
                else:
                    changes["client"] = oid
            elif fid == "fixVersions":
                if not isinstance(value, list):
                    errors[fid] = "data was not an array"
                    continue
                ids = [self._ref_id(v, VERSION_BY_ID, {k: x[0] for k, x in VERSION_BY_NAME.items()}) for v in value]
                if None in ids:
                    errors[fid] = "Version with id '%s' does not exist." % (value[ids.index(None)] or {}).get("id")
                elif any(VERSION_BY_ID[i][2] for i in ids):
                    errors[fid] = "Version '%s' is archived." % next(VERSION_BY_ID[i][1] for i in ids if VERSION_BY_ID[i][2])
                else:
                    changes[fid] = ids
            elif fid == "components":
                if not isinstance(value, list):
                    errors[fid] = "data was not an array"
                    continue
                ids = [self._ref_id(v, COMPONENT_BY_ID, {n: c for c, n in COMPONENTS}) for v in value]
                if None in ids:
                    errors[fid] = "Component with id '%s' does not exist." % (value[ids.index(None)] or {}).get("id")
                else:
                    changes[fid] = ids
            else:
                errors[fid] = "mock_jira: setting '%s' is not implemented." % fid
        return changes, errors

    @staticmethod
    def _ref_id(value: Any, by_id: Dict[str, Any], by_name: Dict[str, str], name_key: str = "name") -> Optional[str]:
        if not isinstance(value, dict):
            return None
        if value.get("id") is not None:
            return str(value["id"]) if str(value["id"]) in by_id else None
        name = value.get(name_key)
        if name is None:
            return None
        return by_name.get(name) or by_name.get(str(name).lower())

    def create_issue(self, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        if not isinstance(body, dict) or not isinstance(body.get("fields"), dict):
            raise ApiError(400, ["Request body must contain 'fields'."])
        if body.get("update"):
            raise ApiError(400, ["mock_jira: 'update' operations on create are not implemented."])
        fields = body["fields"]
        errors = {}  # type: Dict[str, str]
        project = fields.get("project") or {}
        if not isinstance(project, dict) or str(project.get("key") or project.get("id") or "").upper() not in (self.project, PROJECT_ID):
            errors["project"] = "Specify a valid project ID or key"
        itype = fields.get("issuetype") or {}
        tt = None
        if isinstance(itype, dict):
            tt = TYPE_BY_ID.get(str(itype.get("id"))) or TYPE_BY_NAME.get(str(itype.get("name") or "").lower())
        if tt is None:
            errors["issuetype"] = "Specify an issue type"
        if errors:
            raise ApiError(400, [], errors)
        changes, errors = self._validate_fields(fields, tt[0], creating=True)
        for f in self.create_fields(tt[0]):
            fid = f["fieldId"]
            if f["required"] and not f["hasDefaultValue"] and fid not in ("project", "issuetype") and fid not in errors:
                given = fields.get(fid)
                if given in (None, "", []) or (fid == "summary" and not str(given).strip()):
                    errors[fid] = ("You must specify a summary of the issue." if fid == "summary"
                                   else "%s is required." % f["name"])
        if errors:
            raise ApiError(400, [], errors)
        num = self.next_issue
        self.next_issue += 1
        now = self.now()
        issue = self._new_issue(num, tt[0], changes["summary"], now)
        issue["reporter"] = issue["creator"] = changes.pop("reporter", ME_ID)
        self._apply(issue, changes)
        issue["updated"] = now
        self.issues[issue["key"]] = issue
        return 201, {"id": issue["id"], "key": issue["key"], "self": self.issue_self(issue)}

    def _apply(self, issue: Dict[str, Any], changes: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Writes normalised changes onto the issue; returns changelog items for what changed."""
        items = []
        for fid, new in changes.items():
            key = fid
            old = issue[key]
            if old == new:
                continue
            if fid == "summary":
                items.append(self._item("summary", None, old, None, new))
            elif fid == "description":
                items.append(self._item("description", None, adf_text(old).strip() or None, None,
                                        adf_text(new).strip() or None))
            elif fid == "priority":
                items.append(self._item("priority", old, PRIORITY_BY_ID[old][1] if old else None,
                                        new, PRIORITY_BY_ID[new][1] if new else None))
            elif fid in ("assignee", "reporter"):
                items.append(self._item(fid, old, self.user_name(old), new, self.user_name(new)))
            elif fid == "type":
                items.append(self._item("issuetype", old, TYPE_BY_ID[old][1], new, TYPE_BY_ID[new][1]))
            elif fid == "labels":
                items.append(self._item("labels", None, " ".join(old), None, " ".join(new)))
            elif fid == "duedate":
                items.append(self._item("duedate", old, changelog_day(old), new, changelog_day(new)))
            elif fid == "parent":
                o = self.issues.get(old) if old else None
                n = self.issues.get(new) if new else None
                items.append(self._item("IssueParentAssociation", o["id"] if o else None, old,
                                        n["id"] if n else None, new))
            elif fid == "client":
                names = dict(CLIENT_OPTIONS)
                items.append({"field": "Client", "fieldtype": "custom", "fieldId": CLIENT_FIELD, "from": old,
                              "fromString": names.get(old), "to": new, "toString": names.get(new)})
            elif fid in ("fixVersions", "components"):
                label = {"fixVersions": "Fix Version", "components": "Component"}[fid]
                names = {v[0]: v[1] for v in VERSIONS} if fid == "fixVersions" else COMPONENT_BY_ID
                for gone in [x for x in old if x not in new]:
                    items.append({"field": label, "fieldtype": "jira", "fieldId": fid, "from": gone,
                                  "fromString": names[gone], "to": None, "toString": None})
                for added in [x for x in new if x not in old]:
                    items.append({"field": label, "fieldtype": "jira", "fieldId": fid, "from": None,
                                  "fromString": None, "to": added, "toString": names[added]})
            issue[key] = copy.deepcopy(new)
        return items

    def _record_change(self, issue: Dict[str, Any], items: List[Dict[str, Any]], author: str = ME_ID) -> None:
        if not items:
            return
        now = self.now()
        issue["updated"] = now
        self._history(issue, author, now, items)

    def edit_issue(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        if not isinstance(body, dict):
            raise ApiError(400, ["Request body must be a JSON object."])
        fields = body.get("fields") or {}
        if not isinstance(fields, dict):
            raise ApiError(400, ["'fields' must be an object."])
        if body.get("update"):
            fields = dict(fields, **self._update_ops(issue, body["update"], fields))
        changes, errors = self._validate_fields(fields, issue["type"], creating=False, issue=issue)
        if errors:
            raise ApiError(400, [], errors)
        self._record_change(issue, self._apply(issue, changes))
        return 204, None

    # Fields the `update` verbs work on here: id -> (current value in request shape, value -> identity).
    LIST_FIELDS = {
        "labels": (lambda i: list(i["labels"]), lambda v: v),
        "fixVersions": (lambda i: [{"id": x} for x in i["fixVersions"]], lambda v: str(v.get("id")) if isinstance(v, dict) else None),
        "components": (lambda i: [{"id": x} for x in i["components"]], lambda v: str(v.get("id")) if isinstance(v, dict) else None),
    }

    def _update_ops(self, issue: Dict[str, Any], update: Any, fields: Dict[str, Any]) -> Dict[str, Any]:
        """Jira's `update` verbs (add / remove / set) for list fields, applied to the issue's
        current value; returns the resulting values as `fields` entries for the usual validation."""
        if not isinstance(update, dict):
            raise ApiError(400, ["'update' must be an object."])
        out = {}  # type: Dict[str, Any]
        for fid, ops in update.items():
            if fid in fields:
                raise ApiError(400, [], {fid: "Field '%s' cannot be set in both 'fields' and 'update'." % fid})
            if fid not in self.LIST_FIELDS:
                raise ApiError(400, ["mock_jira: 'update' on %s is not implemented." % fid])
            current, ident = self.LIST_FIELDS[fid]
            value = current(issue)
            if not isinstance(ops, list):
                raise ApiError(400, [], {fid: "Operations must be a list."})
            for op in ops:
                if not isinstance(op, dict) or len(op) != 1 or next(iter(op)) not in ("add", "remove", "set"):
                    raise ApiError(400, [], {fid: "Each operation must be one of add, remove, set."})
                verb, v = next(iter(op.items()))
                if verb == "set":
                    value = list(v or [])
                elif verb == "add":
                    if ident(v) is None:
                        raise ApiError(400, [], {fid: "Bad value for add."})
                    if all(ident(x) != ident(v) for x in value):
                        value.append(v)
                else:
                    value = [x for x in value if ident(x) != ident(v)]
            out[fid] = value
        return out

    def delete_issue(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        subs = [i for i in self.issues.values() if i["parent"] == issue["key"] and TYPE_BY_ID[i["type"]][2]]
        if subs and (q.get("deleteSubtasks") or "").lower() != "true":
            raise ApiError(400, ["The issue has subtasks. To delete them, set the deleteSubtasks parameter to true."])
        for i in [issue] + subs:
            del self.issues[i["key"]]
        for child in self.issues.values():
            if child["parent"] == issue["key"]:
                child["parent"] = None
                self._record_change(child, [self._item("IssueParentAssociation", issue["id"], issue["key"], None, None)])
        return 204, None

    def assign(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        if not isinstance(body, dict) or "accountId" not in body:
            raise ApiError(400, ["mock_jira: body must be {\"accountId\": \"...\"} (null to unassign)."])
        acc = body["accountId"]
        if acc == "-1":
            raise ApiError(400, ["mock_jira: automatic assignee (-1) is not implemented."])
        if acc is not None and acc not in self._assignable():
            raise ApiError(400, [], {"assignee": "User '%s' cannot be assigned issues." % acc})
        self._record_change(issue, self._apply(issue, {"assignee": acc}))
        return 204, None

    # ---- transitions ------------------------------------------------------------------------

    def _transitions(self, issue: Dict[str, Any]) -> List[Tuple[str, str, str]]:
        return self._flow(issue).get(STATUS_BY_ID[issue["status"]][1], [])

    def get_transitions(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        out = [{"id": tid, "name": name, "to": self.status_json(STATUS_BY_NAME[target][0]), "hasScreen": False,
                "isGlobal": False, "isInitial": False, "isAvailable": True, "isConditional": False,
                "isLooped": False} for tid, name, target in self._transitions(issue)]
        return 200, {"expand": "transitions", "transitions": out}

    def do_transition(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        tid = str(((body or {}).get("transition") or {}).get("id") or "") if isinstance(body, dict) else ""
        if not tid:
            raise ApiError(400, ["Missing 'transition' identifier"])
        hit = next((x for x in self._transitions(issue) if x[0] == tid), None)
        if hit is None:
            raise ApiError(400, ["Transition id '%s' is not valid for this issue." % tid])
        if body.get("fields") or body.get("update"):
            raise ApiError(400, ["mock_jira: transition screens are not implemented (no fields on transition)."])
        old = issue["status"]
        new = STATUS_BY_NAME[hit[2]][0]
        items = [self._item("status", old, STATUS_BY_ID[old][1], new, STATUS_BY_ID[new][1])]
        issue["status"] = new
        now = self.now()
        if STATUS_BY_ID[old][2] != STATUS_BY_ID[new][2]:
            issue["statuscategorychangedate"] = now
        if STATUS_BY_ID[new][2] == "done":
            res = "Won't Do" if hit[2] == "Canceled" else "Done"
            items.append(self._item("resolution", None, None, "1", res))
            issue["resolution"], issue["resolutiondate"] = res, now
        elif issue["resolution"]:
            items.append(self._item("resolution", "1", issue["resolution"], None, None))
            issue["resolution"] = issue["resolutiondate"] = None
        self._record_change(issue, items)
        return 204, None

    # ---- comments ---------------------------------------------------------------------------

    def _comment(self, issue: Dict[str, Any], cid: str) -> Dict[str, Any]:
        c = next((x for x in issue["comments"] if x["id"] == cid), None)
        if c is None:
            raise ApiError(404, ["Can not find a comment for the id: %s." % cid])
        return c

    @staticmethod
    def _comment_body(body: Any) -> Dict[str, Any]:
        doc_ = body.get("body") if isinstance(body, dict) else None
        if not isinstance(doc_, dict) or doc_.get("type") != "doc":
            raise ApiError(400, [], {"comment": "Comment body is not valid ADF (expected a 'doc' node)."})
        if not adf_text(doc_).strip() and not any(n.get("type") not in ("paragraph",) for n in doc_.get("content") or []):
            raise ApiError(400, [], {"comment": "Comment body can not be empty!"})
        return doc_

    def get_comments(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        order = q.get("orderBy") or "created"
        if order.lstrip("+-") != "created":
            raise ApiError(400, ["mock_jira: orderBy supports only created / -created / +created."])
        comments = sorted(issue["comments"], key=lambda c: (c["created"], int(c["id"])), reverse=order.startswith("-"))
        start = int(q.get("startAt") or 0)
        limit = min(int(q.get("maxResults") or 5000), 5000)
        page = comments[start:start + limit]
        return 200, {"startAt": start, "maxResults": limit, "total": len(comments),
                     "comments": [self.comment_json(issue, c) for c in page]}

    def get_comment(self, ref: str, cid: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        return 200, self.comment_json(issue, self._comment(issue, cid))

    def add_comment(self, ref: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        c = self._new_comment(ME_ID, self._comment_body(body), self.now())
        issue["comments"].append(c)
        issue["updated"] = c["created"]
        return 201, self.comment_json(issue, c)

    def _own(self, c: Dict[str, Any], verb: str) -> None:
        if c["author"] != ME_ID:
            raise ApiError(403, ["You do not have the permission to %s this comment." % verb])

    def update_comment(self, ref: str, cid: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        c = self._comment(issue, cid)
        self._own(c, "edit")
        c["body"] = self._comment_body(body)
        c["updated"] = issue["updated"] = self.now()
        c["updateAuthor"] = ME_ID
        return 200, self.comment_json(issue, c)

    def delete_comment(self, ref: str, cid: str, q: Dict[str, str], body: Any) -> Tuple[int, Any]:
        issue = self.find_issue(ref)
        c = self._comment(issue, cid)
        self._own(c, "delete")
        issue["comments"].remove(c)
        issue["updated"] = self.now()
        return 204, None

    # ---- browse page ------------------------------------------------------------------------

    def browse_page(self, key: str) -> Tuple[int, str]:
        with self.lock:
            issue = self.issues.get(unquote(key).upper())
            if issue is None:
                return 404, "<!doctype html><title>Not found</title><p>Mock Jira: no issue %s</p>" % html.escape(key)
            return 200, ("<!doctype html><meta charset=utf-8><title>%s</title><h1>%s: %s</h1>"
                         "<p>Status: %s</p><p>This is the mock Jira; nothing more to see here.</p>"
                         % (html.escape(issue["key"]), html.escape(issue["key"]), html.escape(issue["summary"]),
                            html.escape(STATUS_BY_ID[issue["status"]][1])))

    # ---- attachments (binary / multipart, outside the JSON dispatch) ---------------------------

    def _attachment(self, att_id: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        for issue in self.issues.values():
            for a in issue["attachments"]:
                if a["id"] == att_id:
                    return issue, a
        raise ApiError(404, ["The attachment with id '%s' does not exist" % att_id])

    def media_token(self, att_id: str) -> str:
        """Stands in for the short-lived token Atlassian puts in media URLs."""
        return hashlib.sha256(("media:%s:%s" % (att_id, self.epoch.isoformat())).encode()).hexdigest()[:24]

    def attachment_redirect(self, att_id: str, kind: str) -> str:
        """Jira Cloud answers attachment/content|thumbnail/{id} with a 303 to Media Services."""
        with self.lock:
            _, a = self._attachment(att_id)
            return "%s/__mock/media/file/%s/binary?id=%s&token=%s%s" % (
                self.base, a["mediaId"], att_id, self.media_token(att_id), "&mode=thumbnail" if kind == "thumbnail" else "")

    def media(self, att_id: str, token: str) -> Tuple[int, bytes, str, str]:
        """The file behind a media URL: (status, bytes, content type, filename). No auth header
        needed (like api.media.atlassian.com), but the token must match."""
        with self.lock:
            try:
                _, a = self._attachment(att_id)
            except ApiError:
                return 404, b"no such file", "text/plain", ""
            if token != self.media_token(att_id):
                return 403, b"bad or expired media token", "text/plain", ""
            data = a.get("data")
            if data is None:
                data = placeholder_file(a["mimeType"], a["filename"])
            return 200, data, a["mimeType"], a["filename"]

    def upload_attachments(self, ref: str, ctype: str, raw: bytes, xsrf: Optional[str]) -> Tuple[int, Any]:
        """POST issue/{key}/attachments: multipart/form-data with one or more "file" parts."""
        if (xsrf or "").lower() != "no-check":
            raise ApiError(403, ["XSRF check failed"])
        if not ctype.lower().startswith("multipart/form-data") or "boundary=" not in ctype:
            raise ApiError(415, ["Unsupported Media Type: expected multipart/form-data"])
        parts = parse_multipart(ctype, raw)
        files = [p for p in parts if p[0] == "file" and p[1]]
        if not files:
            raise ApiError(400, ["No file was found in the request (the form field must be named 'file')."])
        with self.lock:
            issue = self.find_issue(ref)
            out = []
            now = self.now()
            for _, filename, mime, data in files:
                att = {"id": str(self.next_attachment), "filename": filename, "mimeType": mime or "application/octet-stream",
                       "size": len(data), "author": ME_ID, "created": now, "mediaId": str(uuid.uuid4()), "data": data}
                self.next_attachment += 1
                issue["attachments"].append(att)
                self._history(issue, ME_ID, now, [self._item("Attachment", None, None, att["id"], filename)])
                out.append(self.attachment_json(att))
            issue["updated"] = now
            self.reindex()
            return 200, out

    def search_users(self, q: Dict[str, str]) -> Tuple[int, Any]:
        """GET user/search?query= (and user/picker-style lookups): any user, by name or e-mail."""
        needle = (q.get("query") or "").lower()
        users = [self.user_json(u[0]) for u in USERS if not needle or needle in u[1].lower() or needle in u[3]]
        return 200, users[:int(q.get("maxResults") or 50)]


# ---------------------------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server: "MockJiraServer"
    server_version = "MockJira/1.0"

    def _handle(self) -> None:
        if self.server.latency:
            time.sleep(self.server.latency)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        parts = urlsplit(self.path)
        path = parts.path
        m = GATEWAY_RE.match(path)
        if m:
            path = m.group(1)
        if self._files(path, parts.query, raw):
            return
        if path.startswith("/__mock/"):
            return self._control(path, parts.query)
        if path.startswith("/browse/") and self.command == "GET":
            status, page = self.server.jira.browse_page(path[len("/browse/"):])
            return self._send(status, page.encode(), "text/html;charset=UTF-8")
        body = None  # type: Any
        status, payload = 500, None  # type: Tuple[int, Any]
        try:
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8"))
                except ValueError:
                    body = raw.decode("utf-8", "replace")
                    raise ApiError(400, ["Unexpected character in the request body: not valid JSON."])
            if not self.headers.get("Authorization"):
                raise ApiError(401, ["You are not authenticated. Authentication required to perform this operation."])
            if not path.startswith(API):
                raise ApiError(404, ["mock_jira: no route for %s %s" % (self.command, path)])
            status, payload = self.server.jira.dispatch(self.command, path, parse_qs(parts.query), body)
        except ApiError as e:
            status, payload = e.status, e.payload
        except Exception as e:  # a mock bug: make it loud
            status, payload = 500, {"errorMessages": ["mock_jira internal error: %r" % e], "errors": {}}
        self.server.record(self.command, self.path, body, status, self.headers.get("Authorization"))
        if payload is None:
            return self._send(status, b"", None)
        self._send(status, json.dumps(payload).encode(), "application/json;charset=UTF-8")

    do_GET = do_POST = do_PUT = do_DELETE = _handle

    ATTACH_UPLOAD = re.compile(r"^" + API + r"issue/([^/]+)/attachments$")
    ATTACH_FILE = re.compile(r"^" + API + r"attachment/(content|thumbnail)/([^/]+)$")
    MEDIA = re.compile(r"^/__mock/media/file/[^/]+/binary$")

    def _files(self, path: str, query: str, raw: bytes) -> bool:
        """Binary and multipart routes the JSON dispatch can't express. True if handled.

        POST issue/{key}/attachments (multipart, needs X-Atlassian-Token: no-check),
        GET attachment/content|thumbnail/{id} (303 to a media URL, like Jira Cloud),
        GET /__mock/media/file/{mediaId}/binary?id={id}&token= (the bytes; no Authorization, token-checked),
        GET user/search?query=."""
        up = self.ATTACH_UPLOAD.match(path) if self.command == "POST" else None
        dl = self.ATTACH_FILE.match(path) if self.command == "GET" else None
        media = self.MEDIA.match(path) if self.command == "GET" else None
        users = path == API + "user/search" and self.command == "GET"
        if not (up or dl or media or users):
            return False
        jira = self.server.jira
        if media:
            q = parse_qs(query)
            status, data, ctype, name = jira.media((q.get("id") or [""])[-1], (q.get("token") or [""])[-1])
            self.server.record(self.command, self.path, None, status, self.headers.get("Authorization"))
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            if name:
                self.send_header("Content-Disposition", 'inline; filename="%s"' % name.replace('"', ""))
            self.end_headers()
            self.wfile.write(data)
            return True
        body = None  # type: Any
        try:
            if not self.headers.get("Authorization"):
                raise ApiError(401, ["You are not authenticated. Authentication required to perform this operation."])
            if up:
                ctype = self.headers.get("Content-Type") or ""
                status, payload = jira.upload_attachments(unquote(up.group(1)), ctype, raw,
                                                          self.headers.get("X-Atlassian-Token"))
                body = {"multipart": [{"name": n, "filename": f, "contentType": t, "size": len(d)}
                                      for n, f, t, d in parse_multipart(ctype, raw)],
                        "xAtlassianToken": self.headers.get("X-Atlassian-Token")}
            elif dl:
                location = jira.attachment_redirect(unquote(dl.group(2)), dl.group(1))
                self.server.record(self.command, self.path, None, 303, self.headers.get("Authorization"))
                self.send_response(303)
                self.send_header("Location", location)
                self.send_header("Content-Type", "text/html;charset=UTF-8")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return True
            else:
                status, payload = jira.search_users({k: v[-1] for k, v in parse_qs(query).items()})
        except ApiError as e:
            status, payload = e.status, e.payload
        except Exception as e:  # a mock bug: make it loud
            status, payload = 500, {"errorMessages": ["mock_jira internal error: %r" % e], "errors": {}}
        self.server.record(self.command, self.path, body, status, self.headers.get("Authorization"))
        self._send(status, json.dumps(payload).encode(), "application/json;charset=UTF-8")
        return True

    def _control(self, path: str, query: str) -> None:
        if path == "/__mock/requests" and self.command == "GET":
            since = int((parse_qs(query).get("since") or ["0"])[-1])
            data = {"requests": self.server.recorded(since)}
            return self._send(200, json.dumps(data).encode(), "application/json")
        if path == "/__mock/reset" and self.command == "POST":
            self.server.reset()
            return self._send(204, b"", None)
        if path == "/__mock/config" and self.command == "POST":
            lag = (parse_qs(query).get("indexLagMs") or [""])[-1]
            if not lag.isdigit():
                return self._send(400, b'{"errorMessages":["indexLagMs must be a whole number of ms"]}', "application/json")
            self.server.jira.index_lag = int(lag) / 1000.0
            self.server.jira.reindex()
            return self._send(204, b"", None)
        self._send(404, b'{"errorMessages":["unknown mock control endpoint"]}', "application/json")

    def _send(self, status: int, data: bytes, ctype: Optional[str]) -> None:
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", ctype or "application/json")
            self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if status != 204 and data:
            try:
                self.wfile.write(data)
            except OSError:
                pass

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        if self.server.verbose:
            sys.stderr.write("mock-jira %s\n" % (format % args))


class MockJiraServer(ThreadingHTTPServer):
    """The fake Jira on ``host:port`` (port 0 picks a free one; see :attr:`url`)."""

    daemon_threads = True

    def __init__(self, host: str = "127.0.0.1", port: int = 0, log_path: Optional[str] = None,
                 latency_ms: int = 0, project: str = PROJECT_KEY, verbose: bool = False, index_lag_ms: int = 0) -> None:
        super().__init__((host, port), Handler)
        self.url = "http://%s:%d" % (host, self.server_address[1])
        self.jira = MockJira(self.url, project)
        self.jira.index_lag = index_lag_ms / 1000.0
        self.log_path = log_path
        self.latency = latency_ms / 1000.0
        self.verbose = verbose
        self._requests = []  # type: List[Dict[str, Any]]
        self._seq = 0
        self._log_lock = threading.Lock()

    def record(self, method: str, path: str, body: Any, status: int, auth: Optional[str]) -> None:
        with self._log_lock:
            self._seq += 1
            entry = {"seq": self._seq, "time": jtime(datetime.now(timezone.utc)), "method": method, "path": path,
                     "body": body, "status": status, "auth": (auth or "").split(" ")[0] or None}
            self._requests.append(entry)
            if self.log_path:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry) + "\n")

    def recorded(self, since: int = 0) -> List[Dict[str, Any]]:
        with self._log_lock:
            return [copy.deepcopy(r) for r in self._requests if r["seq"] > since]

    def reset(self) -> None:
        self.jira.reset()
        with self._log_lock:
            self._requests = []
            if self.log_path:
                with open(self.log_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"event": "reset", "time": jtime(datetime.now(timezone.utc))}) + "\n")

    def start(self) -> threading.Thread:
        """Serve in a daemon thread (tests); stop with :meth:`stop`."""
        thread = threading.Thread(target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self._thread = thread
        return thread

    def stop(self) -> None:
        self.shutdown()
        self.server_close()
        thread = getattr(self, "_thread", None)
        if thread is not None:
            thread.join(timeout=5)


def _serve_app(mock_url: str, project: str, port: int) -> Any:
    """Starts jira-lite (token mode) against the mock, bypassing .env entirely."""
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    from app.app import create_server
    from app.config import Settings
    settings = Settings(site=mock_url, email="dev@example.com", token="mock-token", project=project, port=port)
    app = create_server(settings)
    threading.Thread(target=app.serve_forever, daemon=True).start()
    return app


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Fake Jira Cloud (REST v3 subset) for jira-lite end-to-end tests.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9900)
    ap.add_argument("--log", help="append every request as a JSON line to this file")
    ap.add_argument("--latency-ms", type=int, default=0, help="delay every response by N ms")
    ap.add_argument("--index-lag-ms", type=int, default=0, help="search/jql trails writes by N ms, like Jira Cloud's index")
    ap.add_argument("--project", default=PROJECT_KEY)
    ap.add_argument("--app-port", type=int, help="also serve jira-lite (token mode, against this mock) on this port")
    ap.add_argument("-v", "--verbose", action="store_true", help="log each request to stderr")
    args = ap.parse_args(argv)
    server = MockJiraServer(args.host, args.port, args.log, args.latency_ms, args.project.upper(), args.verbose,
                            args.index_lag_ms)
    print("mock Jira on %s  (project %s, %d issues; Ctrl+C to stop)"
          % (server.url, args.project.upper(), len(server.jira.issues)), flush=True)
    app = None
    if args.app_port is not None:
        app = _serve_app(server.url, args.project.upper(), args.app_port)
        print("jira-lite on http://localhost:%d  (against the mock)" % app.port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if app is not None:
            app.shutdown()
            app.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
