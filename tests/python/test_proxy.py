"""Unit tests for jira_lite.proxy with an injected opener (no network)."""

import io
import json
import socket
import unittest
import urllib.error
from email.message import Message

from jira_lite.proxy import JiraProxy, UnsafePathError, match_prefix, upstream_url

SITE = "https://x.atlassian.net"


class UpstreamUrlTest(unittest.TestCase):
    def test_mapping(self):
        cases = {
            "/jira/myself": SITE + "/rest/api/3/myself",
            "/jira/search/jql?jql=project%3DBA&maxResults=5":
                SITE + "/rest/api/3/search/jql?jql=project%3DBA&maxResults=5",
            "/jira/": SITE + "/rest/api/3/",
        }
        for path, url in cases.items():
            with self.subTest(path=path):
                self.assertEqual(upstream_url(SITE + "/", path), url)

    def test_non_proxy_paths(self):
        for path in ("/", "/config", "/jira", "/agile/board/7", "/x/jira/a"):
            with self.subTest(path=path):
                self.assertIsNone(match_prefix(path))
                self.assertIsNone(upstream_url(SITE, path))

    def test_dotdot_rejected(self):
        for path in ("/jira/../secret", "/jira/issue/..", "/jira/a/%2e%2e/b", "/jira/%2E%2E/x"):
            with self.subTest(path=path):
                with self.assertRaises(UnsafePathError):
                    upstream_url(SITE, path)

    def test_dotdot_in_query_allowed(self):
        self.assertTrue(upstream_url(SITE, "/jira/search?jql=a..b").endswith("?jql=a..b"))


class _Resp:
    def __init__(self, status, body, ctype):
        self.status = status
        self._body = body
        self.headers = Message()
        if ctype:
            self.headers["Content-Type"] = ctype

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class ForwardTest(unittest.TestCase):
    def setUp(self):
        self.calls = []

    def proxy(self, outcome):
        def opener(req, timeout):
            self.calls.append((req, timeout))
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        return JiraProxy(SITE, "Basic abc", timeout=3, opener=opener)

    def test_get(self):
        r = self.proxy(_Resp(200, b'{"ok":1}', "application/json;charset=UTF-8")).forward("GET", "/jira/myself")
        self.assertEqual(r, (200, b'{"ok":1}', "application/json;charset=UTF-8"))
        req, timeout = self.calls[0]
        self.assertEqual((req.get_method(), req.full_url, timeout), ("GET", SITE + "/rest/api/3/myself", 3))
        self.assertEqual(req.get_header("Authorization"), "Basic abc")
        self.assertEqual(req.get_header("Accept"), "application/json")
        self.assertIsNone(req.data)
        self.assertIsNone(req.get_header("Content-type"))

    def test_post_sets_body_and_content_type(self):
        self.proxy(_Resp(201, b"{}", "application/json")).forward("POST", "/jira/issue", b'{"a":1}')
        req = self.calls[0][0]
        self.assertEqual((req.get_method(), req.data), ("POST", b'{"a":1}'))
        self.assertEqual(req.get_header("Content-type"), "application/json")

    def test_missing_content_type_defaults_to_json(self):
        r = self.proxy(_Resp(204, b"", None)).forward("PUT", "/jira/issue/X-1", b"{}")
        self.assertEqual(r.content_type, "application/json")

    def test_http_error_passthrough(self):
        hdrs = Message()
        hdrs["Content-Type"] = "application/json"
        err = urllib.error.HTTPError(SITE, 404, "Not Found", hdrs, io.BytesIO(b'{"errorMessages":["nope"]}'))
        r = self.proxy(err).forward("GET", "/jira/issue/NOPE-1")
        self.assertEqual(r, (404, b'{"errorMessages":["nope"]}', "application/json"))

    def test_network_errors_become_502(self):
        for exc in (socket.timeout("timed out"), urllib.error.URLError("refused"), ConnectionResetError()):
            with self.subTest(exc=exc):
                r = self.proxy(exc).forward("GET", "/jira/myself")
                self.assertEqual(r.status, 502)
                self.assertEqual(r.content_type, "application/json")
                msg = json.loads(r.body)["errorMessages"][0]
                self.assertTrue(msg.startswith("Proxy error: "), msg)

    def test_forward_rejects_non_proxy_and_unsafe(self):
        p = self.proxy(_Resp(200, b"", None))
        with self.assertRaises(LookupError):
            p.forward("GET", "/config")
        with self.assertRaises(UnsafePathError):
            p.forward("GET", "/jira/../x")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
