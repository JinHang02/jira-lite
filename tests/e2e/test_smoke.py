"""End-to-end smoke test: the real jira-lite server (token mode) in front of the mock Jira.

Both run in this process on ephemeral 127.0.0.1 ports; nothing touches the network. Every
call goes through the app's ``/jira/*`` proxy with the headers the frontend sends (``api.js``),
and the JQL/fields are the ones the frontend builds (``jql.js``, ``api.js``), so a change in
either that the mock or the proxy can't handle shows up here.

Run: python3 -m unittest discover -s tests/e2e -t .
"""

import http.client
import json
import os
import re
import shutil
import tempfile
import threading
import unittest
from html.parser import HTMLParser
from typing import Any, Dict, List, Optional, Set, Tuple

from app.app import create_server
from app.config import Settings
from tests.e2e import mock_jira as mj

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.path.join(REPO, "web")
PROJECT = "DEMO"
TIMEOUT = 10  # seconds per request


# ---- what the frontend sends (read from web/js so the two can't drift) -------------------------

def _js_string_array(source: str, name: str) -> List[str]:
    m = re.search(r"\b" + name + r"\s*=\s*\[(.*?)\]", source, re.S)
    if not m:
        raise AssertionError("%s not found in web/js/api.js" % name)
    return re.findall(r'"([^"]+)"', m.group(1))


with open(os.path.join(WEB, "js", "api.js"), encoding="utf-8") as _f:
    _API_JS = _f.read()
FIELDS = _js_string_array(_API_JS, "FIELDS")
PANEL_FIELDS = _js_string_array(_API_JS, "PANEL_FIELDS")


# Python twins of web/js/jql.js (kept in step by hand; the mock rejects anything else with a 400).
def build_jql(who: str, show_done: bool) -> str:
    jql = 'project = "%s"' % PROJECT
    if who == "mine":
        jql += " AND assignee = currentUser()"
    elif who != "all":
        jql += ' AND assignee = "%s"' % who
    if not show_done:
        jql += " AND statusCategory != Done"
    return jql + " ORDER BY updated DESC"


def delta_jql(minutes: int) -> str:
    return 'project = "%s" AND updated >= -%dm ORDER BY updated DESC' % (PROJECT, max(1, minutes))


def search_jql(q: str) -> str:
    return 'project = "%s" AND text ~ "%s*" ORDER BY updated DESC' % (PROJECT, re.sub(r'["\\]', " ", q).strip())


def children_jql(key: str) -> str:
    return 'parent = "%s" ORDER BY created ASC' % key


def text_to_adf(text: str) -> Dict[str, Any]:
    paras = []
    for para in re.split(r"\n\s*\n", text.strip()):
        content = []  # type: List[Dict[str, Any]]
        for i, line in enumerate(para.split("\n")):
            if i:
                content.append({"type": "hardBreak"})
            if line:
                content.append({"type": "text", "text": line})
        paras.append({"type": "paragraph", "content": content})
    return {"type": "doc", "version": 1, "content": paras}


# ---- servers ------------------------------------------------------------------------------------

class _Env:
    mock = None  # type: mj.MockJiraServer
    app = None  # type: Any
    app_thread = None  # type: threading.Thread
    tmp = ""
    log_path = ""


def setUpModule() -> None:
    _Env.tmp = tempfile.mkdtemp(prefix="jira-lite-e2e-")
    _Env.log_path = os.path.join(_Env.tmp, "requests.jsonl")
    _Env.mock = mj.MockJiraServer(port=0, log_path=_Env.log_path)
    _Env.mock.start()
    settings = Settings(site=_Env.mock.url, email="e2e@example.com", token="e2e-token", project=PROJECT,
                        port=0, timeout=5.0)
    _Env.app = create_server(settings, web_root=WEB, quiet=True)
    _Env.app_thread = threading.Thread(target=_Env.app.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    _Env.app_thread.start()


def tearDownModule() -> None:
    _Env.app.shutdown()
    _Env.app.server_close()
    _Env.app_thread.join(timeout=5)
    _Env.mock.stop()
    shutil.rmtree(_Env.tmp, ignore_errors=True)


def _http(port: int, method: str, path: str, body: Optional[bytes] = None,
          headers: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=TIMEOUT)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        conn.close()


class E2ETestCase(unittest.TestCase):
    """Fresh mock data per test; helpers that call the app like the frontend does."""

    def setUp(self) -> None:
        status, _, _ = _http(_Env.mock.server_address[1], "POST", "/__mock/reset")
        self.assertEqual(status, 204)

    # -- the app ---------------------------------------------------------------------------------

    def app(self, method: str, path: str, body: Any = None,
            extra: Optional[Dict[str, str]] = None) -> Tuple[int, Dict[str, str], bytes]:
        headers = {"X-Jira-Lite": "1"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if method in ("POST", "PUT", "DELETE"):  # browsers send Origin on these, even same-origin
            headers["Origin"] = "http://127.0.0.1:%d" % _Env.app.port
        headers.update(extra or {})
        return _http(_Env.app.port, method, path, data, headers)

    def jira(self, method: str, rest: str, body: Any = None, expect: int = 200) -> Any:
        """A proxied Jira call (api.js `request`); asserts the status and returns the JSON (or None)."""
        status, _, raw = self.app(method, "/jira/" + rest, body)
        data = json.loads(raw) if raw else None
        self.assertEqual(status, expect, "%s /jira/%s -> %s %s" % (method, rest, status, raw[:300]))
        return data

    def search_page(self, jql: str, fields: Optional[List[str]] = None, max_results: int = 100,
                    token: Optional[str] = None) -> Dict[str, Any]:
        body = {"jql": jql, "fields": fields or FIELDS, "maxResults": max_results}  # type: Dict[str, Any]
        if token:
            body["nextPageToken"] = token
        return self.jira("POST", "search/jql", body)

    def search_all(self, jql: str, max_results: int = 100, max_pages: int = 50) -> Tuple[List[Dict[str, Any]], int]:
        """api.searchAll: follows nextPageToken. Returns (issues, pages)."""
        out = []  # type: List[Dict[str, Any]]
        token = None
        for page in range(1, max_pages + 1):
            r = self.search_page(jql, max_results=max_results, token=token)
            out.extend(r["issues"])
            token = r.get("nextPageToken")
            if not token or r.get("isLast"):
                return out, page
        self.fail("pagination did not end")

    def issue(self, key: str, fields: Optional[List[str]] = None, expand: str = "") -> Dict[str, Any]:
        q = "issue/%s?fields=%s" % (key, ",".join(fields or PANEL_FIELDS + [mj.CLIENT_FIELD]))
        return self.jira("GET", q + ("&expand=" + expand if expand else ""))

    def changes(self, key: str) -> List[Dict[str, Any]]:
        """Changelog items of the newest history entry."""
        return self.issue(key, ["summary"], "changelog")["changelog"]["histories"][0]["items"]

    # -- the mock's request log -----------------------------------------------------------------

    def recorded(self, method: Optional[str] = None, contains: str = "") -> List[Dict[str, Any]]:
        _, _, raw = _http(_Env.mock.server_address[1], "GET", "/__mock/requests")
        reqs = json.loads(raw)["requests"]
        return [r for r in reqs if (method is None or r["method"] == method) and contains in r["path"]]

    def last_body(self, method: str, contains: str) -> Any:
        hits = self.recorded(method, contains)
        self.assertTrue(hits, "mock saw no %s %s" % (method, contains))
        return hits[-1]["body"]


class BootstrapTest(E2ETestCase):
    """What main.js loads before the first render."""

    def test_config_auth_and_metadata(self) -> None:
        status, _, raw = self.app("GET", "/config")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"project": PROJECT, "site": _Env.mock.url, "auth": "token"})
        status, _, raw = self.app("GET", "/auth/me")
        self.assertEqual(json.loads(raw), {"auth": "token"})

        me = self.jira("GET", "myself")
        self.assertEqual(me["accountId"], mj.ME_ID)

        users = self.jira("GET", "user/assignable/search?project=%s&maxResults=1000" % PROJECT)
        people = sorted(u["displayName"] for u in users if u["accountType"] == "atlassian")
        self.assertEqual(people, ["Alice Nguyen", "Bob Okafor", "Carol Schmidt", "Sam Rivera"])
        self.assertIn("app", {u["accountType"] for u in users})

        per_type = self.jira("GET", "project/%s/statuses" % PROJECT)
        unique = {s["id"]: s for t in per_type for s in t["statuses"]}  # status.uniqueStatuses
        self.assertEqual(sorted(s["name"] for s in unique.values()),
                         ["Backlog", "Blocked", "Canceled", "Done", "In Progress", "In Review", "To Do"])
        self.assertEqual({s["statusCategory"]["key"] for s in unique.values()}, {"new", "indeterminate", "done"})

        types = self.jira("GET", "issue/createmeta/%s/issuetypes" % PROJECT)["issueTypes"]
        self.assertEqual([t["name"] for t in types], ["Epic", "Task", "Bug", "Story", "Sub-task"])
        epic = next(t for t in types if t["name"] == "Epic")
        self.assertEqual(epic["hierarchyLevel"], 1)
        self.assertTrue(next(t for t in types if t["name"] == "Sub-task")["subtask"])

        # priorities.js: the first non-subtask type's createmeta supplies the priority list.
        first = next(t for t in types if not t["subtask"])
        fields = self.jira("GET", "issue/createmeta/%s/issuetypes/%s?maxResults=200" % (PROJECT, first["id"]))["fields"]
        prio = next(f for f in fields if f["fieldId"] == "priority")
        self.assertEqual([p["name"] for p in prio["allowedValues"]], ["Highest", "High", "Medium", "Low", "Lowest"])
        required = {f["fieldId"]: f for f in fields if f["required"] and not f["hasDefaultValue"]}
        self.assertEqual(set(required), {"summary", "issuetype", "project", mj.CLIENT_FIELD, "fixVersions"})
        self.assertEqual(required[mj.CLIENT_FIELD]["schema"]["type"], "option")
        self.assertEqual(required["fixVersions"]["schema"], {"type": "array", "items": "version", "system": "fixVersions"})
        self.assertTrue(all("id" in v for v in required[mj.CLIENT_FIELD]["allowedValues"]))

    def test_unknown_route_is_a_visible_404(self) -> None:
        data = self.jira("GET", "issue/DEMO-1/worklog", expect=404)
        self.assertIn("mock_jira: no route", data["errorMessages"][0])


class SearchTest(E2ETestCase):

    def test_list_load_paginates_like_search_all(self) -> None:
        jql = build_jql("all", True)
        one, pages = self.search_all(jql)
        self.assertEqual((len(one), pages), (40, 1))
        paged, pages = self.search_all(jql, max_results=7)
        self.assertEqual(pages, 6)
        self.assertEqual([i["key"] for i in paged], [i["key"] for i in one])
        updated = [i["fields"]["updated"] for i in one]
        self.assertEqual(updated, sorted(updated, reverse=True))
        self.assertEqual(set(one[0]["fields"]), set(FIELDS) - ({"parent"} if not one[0]["fields"].get("parent") else set()))
        last = self.search_page(jql, max_results=7, token=self.search_page(jql, max_results=7)["nextPageToken"])
        self.assertFalse(last["isLast"])
        bad = self.jira("POST", "search/jql", {"jql": jql, "fields": FIELDS, "nextPageToken": "nope"}, expect=400)
        self.assertIn("token", bad["errorMessages"][0])

    def test_view_filters(self) -> None:
        mine, _ = self.search_all(build_jql("mine", False))
        self.assertTrue(mine)
        self.assertTrue(all(i["fields"]["assignee"]["accountId"] == mj.ME_ID for i in mine))
        self.assertTrue(all(i["fields"]["status"]["statusCategory"]["key"] != "done" for i in mine))
        alice, _ = self.search_all(build_jql(mj.ALICE_ID, True))
        self.assertEqual({i["fields"]["assignee"]["displayName"] for i in alice}, {"Alice Nguyen"})
        everyone_open, _ = self.search_all(build_jql("all", False))
        everyone, _ = self.search_all(build_jql("all", True))
        self.assertLess(len(everyone_open), len(everyone))
        overdue = [i for i in everyone_open if i["fields"]["duedate"] and i["fields"]["duedate"] < mj.datetime.now().date().isoformat()]
        self.assertTrue(overdue, "seed should include overdue issues")

    def test_delta_sync_sees_only_recent_changes(self) -> None:
        self.assertEqual(self.search_page(delta_jql(3), max_results=100)["issues"], [])
        self.jira("PUT", "issue/DEMO-5", {"fields": {"summary": "Write welcome email copy (v2)"}}, expect=204)
        delta = self.search_page(delta_jql(3), max_results=100)
        self.assertEqual([i["key"] for i in delta["issues"]], ["DEMO-5"])
        self.assertTrue(delta["isLast"])
        self.assertEqual(delta["issues"][0]["fields"]["summary"], "Write welcome email copy (v2)")

    def test_palette_search_and_key_lookup(self) -> None:
        hits = self.search_page(search_jql("signup"), max_results=12)["issues"]
        self.assertIn("DEMO-4", [i["key"] for i in hits])
        self.assertEqual(self.issue("DEMO-4", FIELDS)["key"], "DEMO-4")
        self.jira("GET", "issue/DEMO-999?fields=" + ",".join(FIELDS), expect=404)

    def test_unsupported_jql_is_a_400_with_error_messages(self) -> None:
        for jql in ['project = "DEMO" AND sprint in openSprints()', 'project = "DEMO" OR key = DEMO-1',
                    'project = "DEMO" AND bogus = 1', 'project = "DEMO" AND updated >= -5x']:
            data = self.jira("POST", "search/jql", {"jql": jql, "fields": FIELDS}, expect=400)
            self.assertTrue(data["errorMessages"], jql)


class DetailTest(E2ETestCase):
    """detail.loadDetail: issue + changelog, comments, children."""

    def test_open_issue_with_changelog_comments_and_children(self) -> None:
        listed = self.search_page('project = "DEMO" AND key = "DEMO-4"')["issues"][0]
        type_id = listed["fields"]["issuetype"]["id"]
        fields = self.jira("GET", "issue/createmeta/%s/issuetypes/%s?maxResults=200" % (PROJECT, type_id))["fields"]
        customs = [f["fieldId"] for f in fields if f["required"] and f["fieldId"].startswith("customfield_")]
        self.assertEqual(customs, [mj.CLIENT_FIELD])

        issue = self.jira("GET", "issue/DEMO-4?fields=%s&expand=changelog" % ",".join(PANEL_FIELDS + customs))
        f = issue["fields"]
        self.assertEqual(f["summary"], "Redesign signup flow")
        self.assertEqual(f[mj.CLIENT_FIELD]["value"], "Acme Corp")
        self.assertEqual([v["name"] for v in f["fixVersions"]], ["2026.10"])
        self.assertEqual(f["parent"]["key"], "DEMO-1")
        self.assertEqual([s["key"] for s in f["subtasks"]], ["DEMO-31", "DEMO-32", "DEMO-33"])
        self.assertNotIn("attachment", f)  # not asked for
        kinds = set(re.findall(r'"type": "(\w+)"', json.dumps(f["description"])))
        self.assertTrue({"heading", "orderedList", "bulletList", "mention", "emoji", "mediaSingle", "media"} <= kinds)
        hist = issue["changelog"]["histories"]
        self.assertEqual(issue["changelog"]["total"], len(hist))
        self.assertEqual([h["created"] for h in hist], sorted((h["created"] for h in hist), reverse=True))
        self.assertIn("status", {it["field"] for h in hist for it in h["items"]})

        comments = self.jira("GET", "issue/DEMO-4/comment?orderBy=-created&maxResults=100")["comments"]
        self.assertEqual(len(comments), 3)
        self.assertEqual([c["created"] for c in comments], sorted((c["created"] for c in comments), reverse=True))
        self.assertGreaterEqual(len({c["author"]["accountId"] for c in comments}), 2)

        children = self.search_page(children_jql("DEMO-4"))["issues"]
        self.assertEqual([c["key"] for c in children], ["DEMO-31", "DEMO-32", "DEMO-33"])
        epic_children = self.search_page(children_jql("DEMO-1"))["issues"]
        self.assertEqual(sorted(c["key"] for c in epic_children), ["DEMO-4", "DEMO-5", "DEMO-6", "DEMO-7"])
        created = [c["fields"]["created"] for c in epic_children]
        self.assertEqual(created, sorted(created))

    def test_rich_content_and_long_changelog(self) -> None:
        kinds = lambda key: set(re.findall(r'"type": "(\w+)"', json.dumps(self.issue(key, ["description"])["fields"])))  # noqa: E731
        self.assertTrue({"table", "tableHeader", "tableCell"} <= kinds("DEMO-1"))
        self.assertIn("codeBlock", kinds("DEMO-6"))
        self.assertIn('"marks": [{"type": "link"', json.dumps(self.issue("DEMO-1", ["description"])))
        atts = self.issue("DEMO-14", ["attachment"])["fields"]["attachment"]
        self.assertEqual([a["filename"] for a in atts], ["crash-rotation.mp4", "logcat.txt"])
        log = self.issue("DEMO-39", ["summary"], "changelog")["changelog"]
        self.assertEqual(len(log["histories"]), 100)
        self.assertGreater(log["total"], 100)  # the panel's "N older changes in Jira" note


class WriteTest(E2ETestCase):
    """Every write path the UI has, checked on both sides of the proxy."""

    def test_transitions_follow_the_workflow(self) -> None:
        trans = self.jira("GET", "issue/DEMO-5/transitions")["transitions"]
        self.assertEqual(sorted(t["to"]["name"] for t in trans), ["Backlog", "Canceled", "In Progress"])
        bad = self.jira("POST", "issue/DEMO-5/transitions", {"transition": {"id": "61"}}, expect=400)
        self.assertIn("not valid", bad["errorMessages"][0])
        start = next(t for t in trans if t["to"]["name"] == "In Progress")
        self.jira("POST", "issue/DEMO-5/transitions", {"transition": {"id": start["id"]}}, expect=204)
        self.assertEqual(self.last_body("POST", "/issue/DEMO-5/transitions"), {"transition": {"id": start["id"]}})
        self.assertEqual(self.issue("DEMO-5", ["status"])["fields"]["status"]["name"], "In Progress")
        self.assertEqual([(i["field"], i["fromString"], i["toString"]) for i in self.changes("DEMO-5")],
                         [("status", "To Do", "In Progress")])
        # To Done via review; then it drops out of the open list (statusCategory != Done).
        for target in ("In Review", "Done"):
            t = next(x for x in self.jira("GET", "issue/DEMO-5/transitions")["transitions"] if x["to"]["name"] == target)
            self.jira("POST", "issue/DEMO-5/transitions", {"transition": {"id": t["id"]}}, expect=204)
        done = self.issue("DEMO-5", ["status", "resolution"])["fields"]
        self.assertEqual((done["status"]["statusCategory"]["key"], done["resolution"]["name"]), ("done", "Done"))
        self.assertNotIn("DEMO-5", [i["key"] for i in self.search_all(build_jql("all", False))[0]])

    def test_epic_workflow_differs(self) -> None:
        trans = self.jira("GET", "issue/DEMO-1/transitions")["transitions"]  # epic, In Progress
        self.assertEqual(sorted(t["to"]["name"] for t in trans), ["Done", "To Do"])

    def test_assign_and_unassign(self) -> None:
        self.jira("PUT", "issue/DEMO-24/assignee", {"accountId": mj.ME_ID}, expect=204)
        self.assertEqual(self.last_body("PUT", "/issue/DEMO-24/assignee"), {"accountId": mj.ME_ID})
        self.assertIn("DEMO-24", [i["key"] for i in self.search_all(build_jql("mine", False))[0]])
        self.assertEqual([(i["field"], i["toString"]) for i in self.changes("DEMO-24")], [("assignee", "Sam Rivera")])
        self.jira("PUT", "issue/DEMO-24/assignee", {"accountId": None}, expect=204)
        self.assertIsNone(self.issue("DEMO-24", ["assignee"])["fields"]["assignee"])
        self.jira("PUT", "issue/DEMO-24/assignee", {"accountId": "nobody"}, expect=400)

    def test_field_edits(self) -> None:
        edits = [
            {"priority": {"id": "1"}},
            {"labels": ["onboarding", "copy", "q4"]},
            {"duedate": "2026-12-01"},
            {"summary": "Write the welcome email series"},
            {"description": text_to_adf("Three emails.\n\nKeep them short.")},
        ]
        for fields in edits:
            self.jira("PUT", "issue/DEMO-5", {"fields": fields}, expect=204)
            self.assertEqual(self.last_body("PUT", "/issue/DEMO-5"), {"fields": fields})
        f = self.issue("DEMO-5")["fields"]
        self.assertEqual(f["priority"]["name"], "Highest")
        self.assertEqual(f["labels"], ["onboarding", "copy", "q4"])
        self.assertEqual(f["duedate"], "2026-12-01")
        self.assertEqual(f["summary"], "Write the welcome email series")
        self.assertEqual(f["description"], edits[-1]["description"])
        hist = self.issue("DEMO-5", ["summary"], "changelog")["changelog"]["histories"][:5]
        self.assertEqual([h["items"][0]["field"] for h in hist], ["description", "summary", "duedate", "labels", "priority"])
        self.assertEqual(hist[2]["items"][0]["toString"], "2026-12-01 00:00:00.0")

        self.jira("PUT", "issue/DEMO-5", {"fields": {"duedate": None}}, expect=204)
        self.assertIsNone(self.issue("DEMO-5", ["duedate"])["fields"]["duedate"])
        err = self.jira("PUT", "issue/DEMO-5", {"fields": {"labels": ["two words"]}}, expect=400)
        self.assertIn("labels", err["errors"])
        err = self.jira("PUT", "issue/DEMO-5", {"fields": {"description": "plain string"}}, expect=400)
        self.assertIn("Atlassian Document", err["errors"]["description"])

    def test_editmeta_and_pick_list_edits(self) -> None:
        meta = self.jira("GET", "issue/DEMO-5/editmeta")["fields"]
        # DEMO-5 is under an epic: only same-level types (Epic would break the hierarchy, like the PUT says)
        self.assertEqual([t["name"] for t in meta["issuetype"]["allowedValues"]], ["Task", "Bug", "Story"])
        self.assertEqual(meta["issuetype"]["operations"], [])
        self.assertEqual(meta["fixVersions"]["schema"], {"type": "array", "items": "version", "system": "fixVersions"})
        self.assertEqual(meta[mj.CLIENT_FIELD]["schema"]["type"], "option")
        self.assertIn("set", meta["reporter"]["operations"])
        self.assertNotIn("project", meta)
        sub_types = self.jira("GET", "issue/DEMO-32/editmeta")["fields"]["issuetype"]["allowedValues"]
        self.assertEqual([t["name"] for t in sub_types], ["Sub-task"])

        edits = [
            {"issuetype": {"id": "10002"}},
            {"reporter": {"accountId": mj.CAROL_ID}},
            {"fixVersions": [{"id": "10200"}, {"id": "10201"}]},
            {"components": [{"id": "10301"}]},
            {mj.CLIENT_FIELD: {"id": "10102"}},
        ]
        for fields in edits:
            self.jira("PUT", "issue/DEMO-5", {"fields": fields}, expect=204)
            self.assertEqual(self.last_body("PUT", "/issue/DEMO-5"), {"fields": fields})
        f = self.issue("DEMO-5", ["issuetype", "reporter", "fixVersions", "components", mj.CLIENT_FIELD])["fields"]
        self.assertEqual(f["issuetype"]["name"], "Bug")
        self.assertEqual(f["reporter"]["displayName"], "Carol Schmidt")
        self.assertEqual([v["name"] for v in f["fixVersions"]], ["2026.10", "2026.11"])
        self.assertEqual([c["name"] for c in f["components"]], ["API"])
        self.assertEqual(f[mj.CLIENT_FIELD]["value"], "Initech")
        hist = self.issue("DEMO-5", ["summary"], "changelog")["changelog"]["histories"][:5]
        self.assertEqual([h["items"][0]["field"] for h in hist], ["Client", "Component", "Fix Version", "reporter", "issuetype"])
        self.assertEqual((hist[3]["items"][0]["toString"], hist[4]["items"][0]["toString"]), ("Carol Schmidt", "Bug"))

        # A task under an epic can't become an epic; a sub-task can't become a task.
        err = self.jira("PUT", "issue/DEMO-5", {"fields": {"issuetype": {"id": "10000"}}}, expect=400)
        self.assertIn("hierarchy", err["errors"]["issuetype"])
        err = self.jira("PUT", "issue/DEMO-32", {"fields": {"issuetype": {"id": "10001"}}}, expect=400)
        self.assertIn("issuetype", err["errors"])
        # A type change plus a parent in one request is checked against the new type.
        err = self.jira("PUT", "issue/DEMO-29", {"fields": {"issuetype": {"id": "10000"}, "parent": {"key": "DEMO-2"}}}, expect=400)
        self.assertIn("parent", err["errors"])
        free = self.jira("GET", "issue/DEMO-40/editmeta")["fields"]["issuetype"]["allowedValues"]
        self.assertIn("Epic", [t["name"] for t in free])  # no parent, no children: any standard type

    def test_delete_issue(self) -> None:
        # DEMO-4 has sub-tasks: refused without deleteSubtasks, like Jira.
        err = self.jira("DELETE", "issue/DEMO-4", expect=400)
        self.assertIn("deleteSubtasks", err["errorMessages"][0])
        self.assertEqual(self.issue("DEMO-31", ["summary"])["key"], "DEMO-31")
        self.jira("DELETE", "issue/DEMO-4?deleteSubtasks=true", expect=204)
        for key in ("DEMO-4", "DEMO-31", "DEMO-32", "DEMO-33"):
            self.jira("GET", "issue/%s?fields=summary" % key, expect=404)
        # An epic: its children stay, without a parent.
        self.jira("DELETE", "issue/DEMO-2", expect=204)
        self.assertNotIn("parent", self.issue("DEMO-11", ["parent"])["fields"])
        self.jira("DELETE", "issue/DEMO-2", expect=404)
        status, _, _ = self.app("DELETE", "/jira/issue/DEMO-5", extra={"X-Jira-Lite": "0"})
        self.assertEqual(status, 403)  # the proxy header is still required

    def test_create_issue_validates_required_fields(self) -> None:
        base = {"project": {"key": PROJECT}, "issuetype": {"id": "10001"}, "summary": "Plan the Q1 offsite",
                "description": text_to_adf("Venue and agenda."), "priority": {"id": "2"},
                "assignee": {"accountId": mj.ME_ID}}
        err = self.jira("POST", "issue", {"fields": base}, expect=400)
        self.assertEqual(err["errors"], {mj.CLIENT_FIELD: "Client is required.", "fixVersions": "Fix versions is required."})
        fields = dict(base, **{mj.CLIENT_FIELD: {"id": "10101"}, "fixVersions": [{"id": "10201"}]})
        created = self.jira("POST", "issue", {"fields": fields}, expect=201)
        self.assertEqual(created["key"], "DEMO-41")
        self.assertEqual(self.last_body("POST", "/rest/api/3/issue"), {"fields": fields})
        f = self.issue("DEMO-41")["fields"]
        self.assertEqual((f["summary"], f["priority"]["name"], f["assignee"]["accountId"], f["status"]["name"]),
                         ("Plan the Q1 offsite", "High", mj.ME_ID, "To Do"))
        self.assertEqual((f[mj.CLIENT_FIELD]["value"], f["fixVersions"][0]["name"]), ("Globex", "2026.11"))
        self.assertEqual(self.search_all(build_jql("mine", False))[0][0]["key"], "DEMO-41")  # newest update first
        err = self.jira("POST", "issue", {"fields": dict(fields, fixVersions=[{"id": "10203"}])}, expect=400)
        self.assertIn("archived", err["errors"]["fixVersions"])

    def test_create_sub_issue_inherits_parent_fields(self) -> None:
        sub = next(t for t in self.jira("GET", "issue/createmeta/%s/issuetypes" % PROJECT)["issueTypes"] if t["subtask"])
        meta = self.jira("GET", "issue/createmeta/%s/issuetypes/%s?maxResults=200" % (PROJECT, sub["id"]))["fields"]
        need = [f["fieldId"] for f in meta if f["required"] and not f["hasDefaultValue"]
                and f["fieldId"] not in ("summary", "issuetype", "project", "parent")]
        inherited = self.issue("DEMO-9", need)["fields"]
        fields = {"project": {"key": PROJECT}, "issuetype": {"id": sub["id"]}, "summary": "Retry policy for webhooks",
                  "parent": {"key": "DEMO-9"}}  # type: Dict[str, Any]
        for f in meta:
            if f["fieldId"] in need:
                v = inherited[f["fieldId"]]
                pid = (v[0] if isinstance(v, list) else v)["id"]
                fields[f["fieldId"]] = [{"id": pid}] if f["schema"]["type"] == "array" else {"id": pid}
        no_parent = dict(fields)
        del no_parent["parent"]
        err = self.jira("POST", "issue", {"fields": no_parent}, expect=400)
        self.assertIn("parent", err["errors"])
        key = self.jira("POST", "issue", {"fields": fields}, expect=201)["key"]
        self.assertIn(key, [s["key"] for s in self.issue("DEMO-9", ["subtasks"])["fields"]["subtasks"]])
        self.assertEqual(self.search_page(children_jql("DEMO-9"))["issues"][-1]["key"], key)
        # A story under an epic is fine; a task can't be a parent of a story.
        story = {"project": {"key": PROJECT}, "issuetype": {"id": "10003"}, "summary": "Annual plan discount",
                 "parent": {"key": "DEMO-2"}, mj.CLIENT_FIELD: {"id": "10101"}, "fixVersions": [{"id": "10201"}]}
        self.jira("POST", "issue", {"fields": story}, expect=201)
        err = self.jira("POST", "issue", {"fields": dict(story, parent={"key": "DEMO-9"})}, expect=400)
        self.assertIn("hierarchy", err["errors"]["parent"])

    def test_comment_add_edit_delete(self) -> None:
        added = self.jira("POST", "issue/DEMO-7/comment", {"body": text_to_adf("Unblocked tomorrow?")}, expect=201)
        self.assertEqual(added["author"]["accountId"], mj.ME_ID)
        self.assertEqual(self.last_body("POST", "/issue/DEMO-7/comment"), {"body": text_to_adf("Unblocked tomorrow?")})
        newest = self.jira("GET", "issue/DEMO-7/comment?orderBy=-created&maxResults=100")["comments"][0]
        self.assertEqual(newest["id"], added["id"])

        path = "issue/DEMO-7/comment/" + added["id"]
        edited = self.jira("PUT", path, {"body": text_to_adf("Unblocked on Friday.")})
        self.assertEqual(edited["body"], text_to_adf("Unblocked on Friday."))
        self.assertGreaterEqual(edited["updated"], edited["created"])

        status, headers, raw = self.app("DELETE", "/jira/" + path)
        self.assertEqual((status, raw), (204, b""))
        self.assertEqual(self.recorded("DELETE", path)[-1]["status"], 204)
        ids = [c["id"] for c in self.jira("GET", "issue/DEMO-7/comment?orderBy=-created&maxResults=100")["comments"]]
        self.assertNotIn(added["id"], ids)

        theirs = next(c for c in self.jira("GET", "issue/DEMO-4/comment")["comments"] if c["author"]["accountId"] != mj.ME_ID)
        self.jira("PUT", "issue/DEMO-4/comment/" + theirs["id"], {"body": text_to_adf("hijack")}, expect=403)
        self.jira("POST", "issue/DEMO-7/comment", {"body": text_to_adf("   ")}, expect=400)

    def test_writes_need_the_proxy_header(self) -> None:
        status, _, _ = self.app("PUT", "/jira/issue/DEMO-5", {"fields": {"summary": "x"}}, {"X-Jira-Lite": "0"})
        self.assertEqual(status, 403)
        self.assertEqual(self.recorded("PUT"), [])

    def test_mock_request_log(self) -> None:
        self.jira("GET", "myself")
        self.jira("PUT", "issue/DEMO-5", {"fields": {"labels": ["x"]}}, expect=204)
        reqs = self.recorded()
        self.assertEqual([(r["method"], r["path"], r["status"], r["auth"]) for r in reqs],
                         [("GET", "/rest/api/3/myself", 200, "Basic"), ("PUT", "/rest/api/3/issue/DEMO-5", 204, "Basic")])
        with open(_Env.log_path, encoding="utf-8") as f:
            tail = [json.loads(line) for line in f][-2:]
        self.assertEqual([r["path"] for r in tail], ["/rest/api/3/myself", "/rest/api/3/issue/DEMO-5"])
        self.assertEqual(tail[1]["body"], {"fields": {"labels": ["x"]}})


class _Refs(HTMLParser):
    """Collects href/src attributes of <link> and <script>."""

    def __init__(self) -> None:
        super().__init__()
        self.refs = []  # type: List[str]
        self.scripts = []  # type: List[str]
        self.preloads = []  # type: List[str]

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        a = dict(attrs)
        ref = a.get("src") if tag == "script" else a.get("href") if tag == "link" else None
        if ref:
            self.refs.append(ref)
            if tag == "script":
                self.scripts.append(ref)
            elif a.get("rel") == "modulepreload":
                self.preloads.append(ref)


IMPORT_RE = re.compile(r"""(?:^|[;\s])(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)""", re.M)


class StaticTest(E2ETestCase):

    def get(self, path: str) -> Tuple[int, str, bytes]:
        status, headers, raw = _http(_Env.app.port, "GET", path)
        return status, headers.get("content-type", ""), raw

    def test_index_assets_and_module_graph_resolve(self) -> None:
        status, ctype, raw = self.get("/")
        self.assertEqual((status, ctype.split(";")[0]), (200, "text/html"))
        parser = _Refs()
        parser.feed(raw.decode("utf-8"))
        local = [r for r in parser.refs if not re.match(r"^(https?:|data:|//)", r)]
        names = [r.split("?")[0] for r in local]
        self.assertTrue(any(n.endswith(".css") for n in names) and "js/main.js" in names)
        for ref in local:
            status, ctype, body = self.get("/" + ref)
            self.assertEqual(status, 200, ref)
            self.assertTrue(body, ref)
            css = ref.split("?")[0].endswith(".css")
            want = "text/css" if css else "text/javascript"
            self.assertEqual(ctype.split(";")[0], want, ref)
            if css:  # url(...) references inside stylesheets
                for url in re.findall(r"url\(\s*['\"]?([^'\")]+)", body.decode("utf-8")):
                    if not re.match(r"^(https?:|data:|#)", url):
                        target = os.path.normpath(os.path.join(os.path.dirname(ref), url))
                        self.assertEqual(self.get("/" + target)[0], 200, "%s -> %s" % (ref, url))

        # Walk the ES module graph from every <script type=module>, fetching each import.
        seen = set()  # type: Set[str]
        queue = [r for r in parser.scripts if not re.match(r"^(https?:|//)", r)]
        while queue:
            mod = queue.pop()
            if mod.split("?")[0] in seen:
                continue
            seen.add(mod.split("?")[0])
            status, ctype, body = self.get("/" + mod)
            self.assertEqual(status, 200, "import %s does not resolve" % mod)
            self.assertEqual(ctype.split(";")[0], "text/javascript", mod)
            for m in IMPORT_RE.finditer(body.decode("utf-8")):
                spec = m.group(1) or m.group(2)
                self.assertTrue(spec.startswith("."), "%s imports a bare specifier %r" % (mod, spec))
                queue.append(os.path.normpath(os.path.join(os.path.dirname(mod), spec)))
        on_disk = {"js/" + n for n in os.listdir(os.path.join(WEB, "js")) if n.endswith(".js")}
        self.assertEqual(on_disk - seen, set(), "modules under web/js that nothing imports")
        self.assertGreaterEqual(len(seen), 30)
        # <link rel=modulepreload> lists exactly the module graph (all fetched in parallel at startup).
        self.assertEqual({p.split("?")[0] for p in parser.preloads}, seen, "index.html modulepreload list is out of date")
        # Served links and imports carry one ?v= version, so they can be cached for good.
        versions = {r.split("?v=")[1] if "?v=" in r else None for r in local}
        self.assertEqual(len(versions), 1, versions)  # one version on every js/css link
        self.assertNotIn(None, versions)

    def test_versioned_static_files_are_cached_for_good(self) -> None:
        _, _, raw = self.get("/")
        v = re.search(r'src="js/main\.js\?v=(\w+)"', raw.decode()).group(1)
        status, headers, body = self.app("GET", "/js/main.js?v=" + v)
        self.assertEqual((status, headers["cache-control"]), (200, "public, max-age=31536000, immutable"))
        self.assertIn('?v=%s"' % v, body.decode())  # its own imports are versioned too
        self.assertEqual(self.app("GET", "/js/main.js?v=old")[1]["cache-control"], "no-cache")
        self.assertEqual(self.app("GET", "/")[1]["cache-control"], "no-cache")  # the page always revalidates

    def test_static_files_are_revalidated_with_etags(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", _Env.app.port, timeout=TIMEOUT)
        try:  # one kept-alive connection for both requests
            conn.request("GET", "/js/main.js", headers={"Host": "127.0.0.1:%d" % _Env.app.port})
            r = conn.getresponse()
            body, tag, cache = r.read(), r.getheader("ETag"), r.getheader("Cache-Control")
            self.assertEqual((r.status, cache, r.version), (200, "no-cache", 11))
            self.assertTrue(body and tag)
            conn.request("GET", "/js/main.js", headers={"Host": "127.0.0.1:%d" % _Env.app.port, "If-None-Match": tag})
            r = conn.getresponse()
            self.assertEqual((r.status, r.read(), r.getheader("ETag")), (304, b"", tag))
        finally:
            conn.close()
        self.assertEqual(self.app("GET", "/jira/myself")[1].get("cache-control"), "no-store")  # API answers never cached

    def test_static_missing_and_traversal(self) -> None:
        self.assertEqual(self.get("/js/nope.js")[0], 404)
        self.assertEqual(self.get("/%2e%2e/app/config.py")[0], 404)


if __name__ == "__main__":
    unittest.main()
