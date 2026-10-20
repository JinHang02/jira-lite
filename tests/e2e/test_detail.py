"""End-to-end: detail-panel content features through the real app (token mode) and the mock.

Attachments (multipart upload, same-origin /files/ downloads relayed as redirects), @mentions in
comments, and setting/removing an issue's parent epic. Nothing touches the network.

Run: python3 -m unittest discover -s tests/e2e -t .
"""

import http.client
import json
import shutil
import tempfile
import threading
import unittest
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

from jira_lite.app import create_server
from jira_lite.config import Settings
from tests.e2e import mock_jira as mj

PROJECT = "DEMO"
TIMEOUT = 10
BOUNDARY = "----jle2e9f3c1"
PNG = mj._png(3, 2, "e2e")


class _Env:
    mock = None  # type: mj.MockJiraServer
    app = None  # type: Any
    thread = None  # type: threading.Thread
    tmp = ""


def setUpModule() -> None:
    _Env.tmp = tempfile.mkdtemp(prefix="jira-lite-e2e-detail-")
    _Env.mock = mj.MockJiraServer(port=0)
    _Env.mock.start()
    settings = Settings(site=_Env.mock.url, email="e2e@example.com", token="e2e-token", project=PROJECT,
                        port=0, timeout=5.0)
    _Env.app = create_server(settings, quiet=True)
    _Env.thread = threading.Thread(target=_Env.app.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    _Env.thread.start()


def tearDownModule() -> None:
    _Env.app.shutdown()
    _Env.app.server_close()
    _Env.thread.join(timeout=5)
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


def multipart(files: List[Tuple[str, str, bytes]]) -> Tuple[str, bytes]:
    """[(filename, content type, bytes)] -> (Content-Type, body) as a browser's FormData sends it."""
    out = b""
    for name, ctype, data in files:
        out += ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\n"
                "Content-Type: %s\r\n\r\n" % (BOUNDARY, name, ctype)).encode() + data + b"\r\n"
    return "multipart/form-data; boundary=" + BOUNDARY, out + ("--%s--\r\n" % BOUNDARY).encode()


# Python twin of web/js/props.js epicJql (kept in step by hand).
def epic_jql(query: str = "") -> str:
    jql = 'project = "%s" AND issuetype = "Epic" AND statusCategory != Done' % PROJECT
    if query:
        jql += ' AND summary ~ "%s*"' % query
    return jql + " ORDER BY updated DESC"


class DetailE2E(unittest.TestCase):
    def setUp(self) -> None:
        self.assertEqual(_http(_Env.mock.server_address[1], "POST", "/__mock/reset")[0], 204)
        self.origin = "http://127.0.0.1:%d" % _Env.app.port

    def app(self, method: str, path: str, body: Any = None, headers: Optional[Dict[str, str]] = None,
            raw: Optional[bytes] = None) -> Tuple[int, Dict[str, str], bytes]:
        hdrs = {"X-Jira-Lite": "1"}
        data = raw
        if body is not None:
            hdrs["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        if method != "GET":
            hdrs["Origin"] = self.origin
        hdrs.update(headers or {})
        return _http(_Env.app.port, method, path, data, hdrs)

    def jira(self, method: str, rest: str, body: Any = None, expect: int = 200) -> Any:
        status, _, raw = self.app(method, "/jira/" + rest, body)
        self.assertEqual(status, expect, raw[:300])
        return json.loads(raw) if raw else None

    def recorded(self, method: str, contains: str) -> List[Dict[str, Any]]:
        _, _, raw = _http(_Env.mock.server_address[1], "GET", "/__mock/requests")
        return [r for r in json.loads(raw)["requests"] if r["method"] == method and contains in r["path"]]

    def file(self, path: str, site: str = "same-origin") -> Tuple[int, Dict[str, str], bytes]:
        """What an <img src> on our page sends: no X-Jira-Lite, Sec-Fetch-Site from the browser."""
        return _http(_Env.app.port, "GET", path, headers={"Sec-Fetch-Site": site})

    def follow(self, location: str) -> Tuple[int, Dict[str, str], bytes]:
        """The browser following the relayed redirect to the media host (no credentials)."""
        u = urllib.parse.urlsplit(location)
        return _http(u.port, "GET", u.path + "?" + u.query)

    # -- attachments -----------------------------------------------------------------------------

    def test_seeded_image_thumbnail_and_content_redirect_to_media(self) -> None:
        f = self.jira("GET", "issue/DEMO-4?fields=attachment,description")["fields"]
        (att,) = f["attachment"]
        self.assertEqual((att["filename"], att["mimeType"]), ("signup-step2.png", "image/png"))
        media = [n for n in f["description"]["content"] if n["type"] == "mediaSingle"][0]["content"][0]
        self.assertEqual(media["attrs"]["alt"], att["filename"])  # what the frontend matches on
        for kind in ("thumbnail", "content"):
            status, headers, _ = self.file("/files/%s/%s" % (kind, att["id"]))
            self.assertEqual(status, 303, kind)
            self.assertIn("/__mock/media/%s?token=" % att["id"], headers["location"])
            self.assertEqual(headers["referrer-policy"], "no-referrer")
            status, headers, data = self.follow(headers["location"])
            self.assertEqual((status, headers["content-type"], data[:8]), (200, "image/png", b"\x89PNG\r\n\x1a\n"))
        media_hits = self.recorded("GET", "/__mock/media/")
        self.assertTrue(media_hits and all(r["auth"] is None for r in media_hits), "media must be fetched without our credentials")
        self.assertTrue(all(r["auth"] == "Basic" for r in self.recorded("GET", "/attachment/")))

    def test_upload_multipart_then_download(self) -> None:
        ctype, body = multipart([("shot.png", "image/png", PNG), ("notes.txt", "text/plain", b"hello\n")])
        status, _, raw = self.app("POST", "/jira/issue/DEMO-5/attachments", headers={"Content-Type": ctype}, raw=body)
        self.assertEqual(status, 200, raw)
        added = json.loads(raw)
        self.assertEqual([(a["filename"], a["size"]) for a in added], [("shot.png", len(PNG)), ("notes.txt", 6)])
        rec = self.recorded("POST", "/DEMO-5/attachments")[-1]
        self.assertEqual(rec["body"]["xAtlassianToken"], "no-check")
        self.assertEqual([p["filename"] for p in rec["body"]["multipart"]], ["shot.png", "notes.txt"])
        f = self.jira("GET", "issue/DEMO-5?fields=attachment&expand=changelog")
        self.assertEqual([a["filename"] for a in f["fields"]["attachment"]], ["shot.png", "notes.txt"])
        self.assertEqual(f["changelog"]["histories"][0]["items"][0]["field"], "Attachment")
        status, headers, _ = self.file("/files/content/%s" % added[0]["id"])
        self.assertEqual(status, 303)
        self.assertEqual(self.follow(headers["location"])[2], PNG)

    def test_upload_needs_the_proxy_header_and_xsrf_token_upstream(self) -> None:
        ctype, body = multipart([("a.txt", "text/plain", b"x")])
        status, _, _ = _http(_Env.app.port, "POST", "/jira/issue/DEMO-5/attachments", body, {"Content-Type": ctype})
        self.assertEqual(status, 403)  # no X-Jira-Lite: a cross-site form can't upload
        # Straight to the mock without the token header: Jira's own XSRF check refuses it.
        status, _, raw = _http(_Env.mock.server_address[1], "POST", "/rest/api/3/issue/DEMO-5/attachments", body,
                               {"Content-Type": ctype, "Authorization": "Basic x"})
        self.assertEqual(status, 403, raw)

    def test_file_routes_refuse_other_sites(self) -> None:
        self.assertEqual(self.file("/files/content/10500", site="cross-site")[0], 403)
        self.assertEqual(self.file("/files/content/99999")[0], 404)  # unknown attachment: Jira's 404 relayed
        self.assertEqual(self.recorded("GET", "/attachment/content/10500"), [])

    # -- mentions --------------------------------------------------------------------------------

    def test_comment_with_mention_round_trips(self) -> None:
        body = {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "Thanks "}, {"type": "mention", "attrs": {"id": mj.ALICE_ID, "text": "@Alice Nguyen"}},
            {"type": "text", "text": ", mail sam@example.com"}]}]}
        c = self.jira("POST", "issue/DEMO-5/comment", {"body": body}, expect=201)
        self.assertEqual(c["body"]["content"][0]["content"][1], body["content"][0]["content"][1])
        users = self.jira("GET", "user/search?query=ali")
        self.assertEqual([u["displayName"] for u in users], ["Alice Nguyen"])

    # -- parent ----------------------------------------------------------------------------------

    def search(self, jql: str) -> List[str]:
        r = self.jira("POST", "search/jql", {"jql": jql, "fields": ["summary", "status", "issuetype"], "maxResults": 50})
        return sorted(i["key"] for i in r["issues"])

    def test_epic_picker_jql(self) -> None:
        self.assertEqual(self.search(epic_jql()), ["DEMO-1", "DEMO-2", "DEMO-3"])
        self.assertEqual(self.search(epic_jql("bill")), ["DEMO-2"])
        jql = 'project = "%s" AND issuetype = "Epic" AND statusCategory != Done AND key = "DEMO-3" ORDER BY updated DESC' % PROJECT
        self.assertEqual(self.search(jql), ["DEMO-3"])

    def test_set_change_and_remove_parent(self) -> None:
        self.jira("PUT", "issue/DEMO-24", {"fields": {"parent": {"key": "DEMO-2"}}}, expect=204)
        f = self.jira("GET", "issue/DEMO-24?fields=parent")["fields"]
        self.assertEqual((f["parent"]["key"], f["parent"]["fields"]["summary"]), ("DEMO-2", "Billing v2"))
        self.jira("PUT", "issue/DEMO-24", {"fields": {"parent": {"key": "DEMO-1"}}}, expect=204)
        self.jira("PUT", "issue/DEMO-24", {"fields": {"parent": None}}, expect=204)
        f = self.jira("GET", "issue/DEMO-24?fields=parent&expand=changelog")
        self.assertNotIn("parent", f["fields"])
        item = f["changelog"]["histories"][0]["items"][0]
        self.assertEqual((item["field"], item["fromString"], item["toString"]), ("IssueParentAssociation", "DEMO-1", None))
        self.assertEqual(self.recorded("PUT", "/issue/DEMO-24")[-1]["body"], {"fields": {"parent": None}})

    def test_parent_must_be_an_epic(self) -> None:
        status, _, raw = self.app("PUT", "/jira/issue/DEMO-24", {"fields": {"parent": {"key": "DEMO-5"}}})
        self.assertEqual(status, 400)
        self.assertIn("hierarchy", json.loads(raw)["errors"]["parent"])


if __name__ == "__main__":
    unittest.main()
