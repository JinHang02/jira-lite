"""End-to-end tests for the list/navigation features: the sidebar's Epics (open epics + one
``parent in (...)`` progress search), the epic filter, and the requests bulk edits send
(transitions per issue, priority / labels PUTs, assignee PUTs). Same harness as test_smoke:
the real app proxy in front of the mock Jira, on ephemeral 127.0.0.1 ports.

Run: python3 -m unittest discover -s tests/e2e -t .
"""

import json
import os
import shutil
import subprocess
import unittest
from typing import Any, Dict, List

from tests.e2e import mock_jira as mj
from tests.e2e.test_smoke import E2ETestCase, FIELDS, PROJECT, WEB, build_jql, delta_jql
from tests.e2e.test_smoke import setUpModule, tearDownModule  # noqa: F401  (unittest runs them for this module)


# Python twins of web/js/epics.js and the epic branch of jql.buildJql (checked against the JS below).
def epics_jql() -> str:
    return 'project = "%s" AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC' % PROJECT


def epic_children_jql(keys: List[str]) -> str:
    return "parent in (%s)" % ", ".join('"%s"' % k for k in keys)


def epic_view_jql(epic: str, show_done: bool) -> str:
    jql = 'project = "%s" AND parent = "%s"' % (PROJECT, epic)
    if not show_done:
        jql += " AND statusCategory != Done"
    return jql + " ORDER BY updated DESC"


def keys(issues: List[Dict[str, Any]]) -> List[str]:
    return [i["key"] for i in issues]


class FrontendJqlTest(unittest.TestCase):
    """The JQL the browser builds is exactly what these tests send to the mock."""

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_js_builders_match_the_python_twins(self) -> None:
        script = (
            "const j = await import(process.argv[1] + '/js/jql.js');"
            "const e = await import(process.argv[1] + '/js/epics.js');"
            "console.log(JSON.stringify(["
            "e.epicsJql('DEMO'), e.epicChildrenJql(['DEMO-1', 'DEMO-2']),"
            "j.buildJql({project: 'DEMO', who: 'mine', showDone: false, epic: 'DEMO-2'}),"
            "j.buildJql({project: 'DEMO', who: 'all', showDone: true, epic: 'DEMO-3'}),"
            "j.buildJql({project: 'DEMO', who: 'all', showDone: false, epic: null})]));"
        )
        out = subprocess.run(["node", "--input-type=module", "-e", script, "file://" + WEB], capture_output=True,
                             text=True, timeout=30, check=True).stdout
        self.assertEqual(json.loads(out), [
            epics_jql(), epic_children_jql(["DEMO-1", "DEMO-2"]), epic_view_jql("DEMO-2", False),
            epic_view_jql("DEMO-3", True), build_jql("all", False),
        ])


class EpicsTest(E2ETestCase):

    def test_sidebar_epics_with_one_progress_search(self) -> None:
        epics = self.search_page(epics_jql(), fields=["summary", "status"], max_results=50)["issues"]
        self.assertEqual(keys(epics), ["DEMO-1", "DEMO-2", "DEMO-3"])  # updated DESC
        self.assertEqual(set(epics[0]["fields"]), {"summary", "status"})
        kids = self.search_page(epic_children_jql(keys(epics)), fields=["status", "parent"])["issues"]
        self.assertEqual(set(kids[0]["fields"]), {"status", "parent"})
        progress = {}  # type: Dict[str, List[int]]
        for k in kids:  # epics.epicProgress
            p = progress.setdefault(k["fields"]["parent"]["key"], [0, 0])
            p[1] += 1
            p[0] += k["fields"]["status"]["statusCategory"]["key"] == "done"
        self.assertEqual(progress, {"DEMO-1": [0, 4], "DEMO-2": [0, 5], "DEMO-3": [1, 4]})

        # A finished epic drops out of the list.
        self.jira("POST", "issue/DEMO-1/transitions", {"transition": {"id": "61"}}, expect=204)
        self.assertEqual(keys(self.search_page(epics_jql(), fields=["summary"])["issues"]), ["DEMO-2", "DEMO-3"])

    def test_epic_filter_lists_children_of_any_assignee(self) -> None:
        open_kids = self.search_all(epic_view_jql("DEMO-3", False))[0]
        self.assertEqual(sorted(keys(open_kids)), ["DEMO-12", "DEMO-13", "DEMO-14"])
        self.assertEqual({(i["fields"]["assignee"] or {}).get("displayName") for i in open_kids}, {"Carol Schmidt", None})
        self.assertEqual(sorted(keys(self.search_all(epic_view_jql("DEMO-3", True))[0])), ["DEMO-12", "DEMO-13", "DEMO-14", "DEMO-15"])
        # Every row carries its parent, which matchesView needs to keep delta-synced rows in the epic view.
        self.assertTrue(all(i["fields"]["parent"]["key"] == "DEMO-3" for i in open_kids))
        self.jira("PUT", "issue/DEMO-13", {"fields": {"summary": "Profile image cache hit rate (p95)"}}, expect=204)
        delta = self.search_page(delta_jql(3))["issues"]
        self.assertEqual([(i["key"], i["fields"]["parent"]["key"]) for i in delta], [("DEMO-13", "DEMO-3")])

    def test_in_lists_in_the_mock_jql(self) -> None:
        not_in = self.search_all('project = "DEMO" AND issuetype != Epic AND parent not in (DEMO-1, "DEMO-2") AND parent is not EMPTY')[0]
        self.assertEqual(sorted(keys(not_in), key=lambda k: int(k.split("-")[1])),
                         ["DEMO-12", "DEMO-13", "DEMO-14", "DEMO-15", "DEMO-31", "DEMO-32", "DEMO-33", "DEMO-34", "DEMO-35",
                          "DEMO-36", "DEMO-37", "DEMO-38"])
        for jql in ['parent in (DEMO-1, DEMO-999)', 'parent in ("DEMO-1"', 'parent in ()', 'project = "DEMO" AND sprint in openSprints()',
                    'project = "DEMO" AND summary in (a, b)']:
            data = self.jira("POST", "search/jql", {"jql": jql, "fields": FIELDS}, expect=400)
            self.assertTrue(data["errorMessages"], jql)


class BulkTest(E2ETestCase):
    """What selection.js sends for a bulk edit, against the mock's workflow and field rules."""

    SELECTED = ["DEMO-5", "DEMO-9", "DEMO-8", "DEMO-6"]  # To Do, To Do, In Progress, In Review

    def transitions(self) -> Dict[str, List[Dict[str, Any]]]:
        return {k: self.jira("GET", "issue/%s/transitions" % k)["transitions"] for k in self.SELECTED}

    def status_of(self, key: str) -> str:
        return self.issue(key, ["status"])["fields"]["status"]["name"]

    def test_bulk_status_union_of_targets_and_partial_moves(self) -> None:
        trans = self.transitions()
        current = {k: self.status_of(k) for k in self.SELECTED}
        union = {}  # type: Dict[str, int]  # bulk.unionTargets
        for k, ts in trans.items():
            for name in {t["to"]["name"] for t in ts if t["to"]["name"] != current[k]}:
                union[name] = union.get(name, 0) + 1
        self.assertEqual(union, {"Backlog": 2, "Canceled": 2, "In Progress": 3, "To Do": 1, "In Review": 1, "Blocked": 1, "Done": 1})

        # Move to Done: only DEMO-6 (In Review) has a transition there; the rest "can't move".
        moves = [(k, next(t["id"] for t in ts if t["to"]["name"] == "Done")) for k, ts in trans.items()
                 if any(t["to"]["name"] == "Done" for t in ts)]
        self.assertEqual(moves, [("DEMO-6", "61")])
        for k, tid in moves:
            self.jira("POST", "issue/%s/transitions" % k, {"transition": {"id": tid}}, expect=204)
        posts = [r for r in self.recorded("POST") if r["path"].endswith("/transitions")]
        self.assertEqual([(r["path"].split("/")[-2], r["body"]) for r in posts], [("DEMO-6", {"transition": {"id": "61"}})])
        self.assertEqual(self.status_of("DEMO-6"), "Done")

        # Move to In Progress: the two To Do issues and DEMO-6 (reopened), DEMO-8 is already there.
        trans = self.transitions()
        plan = {k: next((t["id"] for t in ts if t["to"]["name"] == "In Progress"), None) for k, ts in trans.items()}
        self.assertEqual(plan, {"DEMO-5": "31", "DEMO-9": "31", "DEMO-8": None, "DEMO-6": "81"})
        for k, tid in plan.items():
            if tid:
                self.jira("POST", "issue/%s/transitions" % k, {"transition": {"id": tid}}, expect=204)
        self.assertEqual({k: self.status_of(k) for k in self.SELECTED}, dict.fromkeys(self.SELECTED, "In Progress"))

    def test_bulk_priority_assignee_and_labels(self) -> None:
        for k in self.SELECTED:
            self.jira("PUT", "issue/" + k, {"fields": {"priority": {"id": "2"}}}, expect=204)
        self.assertEqual({self.issue(k, ["priority"])["fields"]["priority"]["name"] for k in self.SELECTED}, {"High"})

        for k in self.SELECTED:
            self.jira("PUT", "issue/%s/assignee" % k, {"accountId": mj.ALICE_ID}, expect=204)
        self.assertEqual({self.issue(k, ["assignee"])["fields"]["assignee"]["displayName"] for k in self.SELECTED}, {"Alice Nguyen"})

        # Labels: each PUT carries the issue's own labels plus the new one (bulk.labelsPlan).
        before = {k: self.issue(k, ["labels"])["fields"]["labels"] for k in self.SELECTED}
        self.assertEqual(before["DEMO-9"], ["billing", "backend"])
        for k in self.SELECTED:
            self.jira("PUT", "issue/" + k, {"fields": {"labels": before[k] + ["urgent"]}}, expect=204)
        after = {k: self.issue(k, ["labels"])["fields"]["labels"] for k in self.SELECTED}
        self.assertEqual(after, {k: v + ["urgent"] for k, v in before.items()})
        self.assertEqual(self.last_body("PUT", "/issue/DEMO-9"), {"fields": {"labels": ["billing", "backend", "urgent"]}})
        self.assertEqual(self.changes("DEMO-9")[0]["toString"], "billing backend urgent")


if __name__ == "__main__":
    unittest.main()
