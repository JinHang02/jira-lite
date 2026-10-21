"""Attachments: multipart upload passthrough, body size limit, redirect relaying and the
same-origin /files/ routes (token and OAuth mode)."""

import http.client
import unittest
import urllib.request

from jira_lite import files
from jira_lite.proxy import MAX_BODY, JiraProxy, no_redirect_opener, outgoing

from .atlassian_fake import CLOUD_ID, OAuthAppTestCase
from .support import MEDIA_PATH, MEDIA_UUID, PNG_BYTES, AppTestCase, FakeJira, start, stop

BOUNDARY = "----jlboundary7MA4YWxk"
MULTIPART = "multipart/form-data; boundary=" + BOUNDARY
BODY = ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n"
        "Content-Type: image/png\r\n\r\n" % BOUNDARY).encode() + PNG_BYTES + b"\x00\xff\r\n--" + BOUNDARY.encode() + b"--\r\n"
ALLOWED = frozenset({"http://localhost:8765", "http://127.0.0.1:8765"})


class FilesPureTest(unittest.TestCase):
    def test_proxy_path(self):
        self.assertEqual(files.proxy_path("/files/content/10500"), "/jira/attachment/content/10500")
        self.assertEqual(files.proxy_path("/files/thumbnail/7"), "/jira/attachment/thumbnail/7")
        for bad in ("/files/content/", "/files/content/abc", "/files/content/1/x", "/files/meta/1",
                    "/files/content/1?x", "/files/content/%2e%2e", "/files/content/../1", "/files/"):
            with self.subTest(path=bad):
                self.assertIsNone(files.proxy_path(bad))

    def test_fetch_metadata_decides_when_present(self):
        for site, ok in (("same-origin", True), ("none", True), ("same-site", False), ("cross-site", False),
                         ("Same-Origin", True)):
            with self.subTest(site=site):
                # Sec-Fetch-Site wins over a (spoofable-looking) Referer.
                hdrs = {"Sec-Fetch-Site": site, "Referer": "http://localhost:8765/"}
                self.assertIs(files.fetch_allowed(hdrs, ALLOWED), ok)

    def test_safari_cross_site_link_click_falls_back_to_referer(self):
        # Safari marks a target=_blank rel=noopener click on our own page as cross-site.
        nav = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document"}
        self.assertTrue(files.fetch_allowed(dict(nav, Referer="http://localhost:8765/"), ALLOWED))
        self.assertFalse(files.fetch_allowed(dict(nav, Referer="http://evil.test/"), ALLOWED))
        self.assertFalse(files.fetch_allowed(nav, ALLOWED))
        # Subresources from elsewhere stay refused even with our Referer (only a non-browser could send that).
        img = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors", "Referer": "http://localhost:8765/"}
        self.assertFalse(files.fetch_allowed(img, ALLOWED))

    def test_referer_or_origin_without_fetch_metadata(self):
        cases = [({}, False), ({"Referer": "http://localhost:8765/#BA-1"}, True),
                 ({"Origin": "http://127.0.0.1:8765"}, True), ({"Referer": "http://evil.test/"}, False),
                 ({"Referer": "http://localhost:8766/"}, False), ({"Referer": "not a url"}, False),
                 ({"Origin": "null"}, False)]
        for hdrs, ok in cases:
            with self.subTest(hdrs=hdrs):
                self.assertIs(files.fetch_allowed(hdrs, ALLOWED), ok)

    def test_redirect_ok(self):
        self.assertTrue(files.redirect_ok("https://api.media.atlassian.com/file/x/binary?token=t"))
        for bad in (None, "", "/relative", "javascript:alert(1)", "data:text/html,x", "https://"):
            with self.subTest(location=bad):
                self.assertFalse(files.redirect_ok(bad))

    def test_media_path_and_id(self):
        self.assertEqual(files.media_path("/files/media/25569"), "/jira/attachment/content/25569")
        for bad in ("/files/media/", "/files/media/x", "/files/media/1/2", "/files/content/1"):
            self.assertIsNone(files.media_path(bad))
        loc = "https://api.media.atlassian.com/file/CEBF256E-58b9-4541-82f2-13ab1ef4a0d2/binary?token=t&dl=true"
        self.assertEqual(files.media_id(loc), "cebf256e-58b9-4541-82f2-13ab1ef4a0d2")
        for bad in (None, "", "/file/cebf256e-58b9-4541-82f2-13ab1ef4a0d2/binary", "https://m/file/1/binary",
                    "https://m/x?u=/file/cebf256e-58b9-4541-82f2-13ab1ef4a0d2/"):
            with self.subTest(location=bad):
                self.assertIsNone(files.media_id(bad))

    def test_file_headers(self):
        relayed = (("Location", "https://m/x"), ("Content-Disposition", "attachment"))
        h = dict(files.file_headers(303, relayed))
        self.assertEqual(h["Location"], "https://m/x")
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertIn("sandbox", h["Content-Security-Policy"])
        self.assertEqual(h["Referrer-Policy"], "no-referrer")
        self.assertNotIn("Location", dict(files.file_headers(200, relayed)))


class OutgoingTest(unittest.TestCase):
    def test_multipart_only_for_attachment_upload(self):
        out = outgoing("POST", "/jira/issue/BA-1/attachments", MULTIPART)
        self.assertEqual(out.content_type, MULTIPART)
        self.assertEqual(out.extra, (("X-Atlassian-Token", "no-check"),))
        for method, path, ctype in (("POST", "/jira/issue/BA-1/comment", MULTIPART),
                                    ("PUT", "/jira/issue/BA-1/attachments", MULTIPART),
                                    ("POST", "/jira/issue/BA-1/attachments", "multipart/form-data"),
                                    ("POST", "/jira/issue/BA-1/attachments", "application/json"),
                                    ("POST", "/jira/issue/BA-1/attachments/x", MULTIPART),
                                    ("POST", "/jira/issue/BA-1/attachments", None)):
            with self.subTest(method=method, path=path, ctype=ctype):
                out = outgoing(method, path, ctype)
                self.assertEqual(out.content_type, "application/json")
                self.assertEqual(out.extra, ())

    def test_accept(self):
        self.assertEqual(outgoing("GET", "/jira/attachment/content/1").accept, "*/*")
        self.assertEqual(outgoing("GET", "/jira/attachment/thumbnail/1?width=200").accept, "*/*")
        self.assertEqual(outgoing("GET", "/jira/issue/BA-1").accept, "application/json")


class NoRedirectOpenerTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeJira()
        self.thread = start(self.fake)

    def tearDown(self):
        stop(self.fake, self.thread)

    def test_default_opener_relays_redirect_without_following(self):
        proxy = JiraProxy(self.fake.url, "Basic secret", timeout=5)
        r = proxy.forward("GET", "/jira/attachment/content/42")
        self.assertEqual(r.status, 303)
        self.assertEqual(dict(r.headers)["Location"], self.fake.url + MEDIA_PATH + "42?token=short-lived")
        self.assertEqual([q["path"] for q in self.fake.requests], ["/rest/api/3/attachment/content/42"])

    def test_opener_is_urlopen_compatible(self):
        opener = no_redirect_opener()
        with opener(urllib.request.Request(self.fake.url + "/rest/api/3/myself"), timeout=5) as resp:
            self.assertEqual(resp.status, 200)


class TokenModeFilesTest(AppTestCase):
    def file(self, path, **headers):
        return self.request("GET", path, headers=headers or {"Sec-Fetch-Site": "same-origin"}, proxy_header=False)

    def test_content_redirect_is_relayed_not_followed(self):
        status, headers, body = self.file("/files/content/10500")
        self.assertEqual(status, 303)
        self.assertEqual(headers["location"], self.fake.url + MEDIA_PATH + "10500?token=short-lived")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["referrer-policy"], "no-referrer")
        self.assertIn("sandbox", headers["content-security-policy"])
        (call,) = self.fake.requests  # nothing reached the media URL
        self.assertEqual(call["path"], "/rest/api/3/attachment/content/10500")
        self.assertTrue(call["headers"]["Authorization"].startswith("Basic "))
        self.assertEqual(call["headers"]["Accept"], "*/*")
        self.assertNotIn("X-Jira-Lite", call["headers"])

    def test_direct_bytes_pass_through(self):
        status, headers, body = self.file("/files/thumbnail/7")
        self.assertEqual((status, body), (200, PNG_BYTES))
        self.assertEqual(headers["content-type"], "image/png")
        self.assertEqual(headers["content-disposition"], 'inline; filename="a.png"')
        self.assertNotIn("location", headers)

    def test_media_id_route(self):
        status, _, body = self.request("GET", "/files/media/10601")
        self.assertEqual((status, body), (200, b'{"id": "%s"}' % MEDIA_UUID.encode()))
        (call,) = self.fake.requests  # the redirect was read, not followed
        self.assertEqual(call["path"], "/rest/api/3/attachment/content/10601")
        self.assertEqual(self.request("GET", "/files/media/10500")[0], 502)  # redirect without a media id
        self.assertEqual(self.request("GET", "/files/media/10601", proxy_header=False)[0], 403)
        self.assertIn(self.request("GET", "/files/media/abc")[0], (403, 404))  # non-numeric: not this route
        status, headers, body = self.request("GET", "/files/media/10602")  # upstream bytes are never relayed here
        self.assertEqual((status, headers["content-type"].split(";")[0]), (502, "application/json"))

    def test_no_framing_anywhere(self):
        for path, proxy in (("/", False), ("/files/media/10601", True), ("/jira/nothing/../x", True)):
            with self.subTest(path=path):
                _, headers, _ = self.request("GET", path, proxy_header=proxy)
                self.assertEqual(headers["x-frame-options"], "DENY")
                self.assertIn("frame-ancestors 'none'", headers["content-security-policy"])

    def test_referer_fallback(self):
        own = "http://127.0.0.1:%d/" % self.port
        self.assertEqual(self.file("/files/content/1", Referer=own)[0], 303)
        self.assertEqual(self.file("/files/content/1", Referer="http://evil.test/")[0], 403)

    def test_cross_site_and_unmarked_requests_are_refused(self):
        for headers in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"X-Nothing": "1"}):
            with self.subTest(headers=headers):
                status, _, _ = self.request("GET", "/files/content/1", headers=headers, proxy_header=False)
                self.assertEqual(status, 403)
        self.assertEqual(self.fake.requests, [])

    def test_bad_host_refused(self):
        status, _, _ = self.request("GET", "/files/content/1",
                                    headers={"Host": "evil.test", "Sec-Fetch-Site": "same-origin"}, proxy_header=False)
        self.assertEqual(status, 403)

    def test_only_numeric_ids(self):
        for path in ("/files/content/abc", "/files/content/1/x", "/files/content/%2e%2e%2fissue",
                     "/files/other/1", "/files/content/1/../../myself"):
            with self.subTest(path=path):
                self.assertEqual(self.file(path)[0], 404)
        self.assertEqual(self.fake.requests, [])

    def test_files_route_is_get_only(self):
        status, _, _ = self.request("POST", "/files/content/1", body=b"{}",
                                    headers={"Sec-Fetch-Site": "same-origin"}, proxy_header=False)
        self.assertEqual(status, 403)  # no X-Jira-Lite: the proxy rules apply, nothing forwarded
        status, _, _ = self.request("POST", "/files/content/1", body=b"{}")
        self.assertEqual(status, 404)
        self.assertEqual(self.fake.requests, [])

    def test_proxy_route_relays_redirects_too(self):
        status, headers, _ = self.request("GET", "/jira/attachment/content/5")
        self.assertEqual(status, 303)
        self.assertTrue(headers["location"].startswith(self.fake.url + MEDIA_PATH))
        self.assertEqual(len(self.fake.requests), 1)


class UploadTest(AppTestCase):
    def test_multipart_passes_through_unchanged(self):
        status, _, _ = self.request("POST", "/jira/issue/TST-1/attachments", body=BODY,
                                    headers={"Content-Type": MULTIPART})
        self.assertEqual(status, 201)
        (call,) = self.fake.requests
        self.assertEqual(call["path"], "/rest/api/3/issue/TST-1/attachments")
        self.assertEqual(call["body"], BODY)
        self.assertEqual(call["headers"]["Content-Type"], MULTIPART)
        self.assertEqual(call["headers"]["X-Atlassian-Token"], "no-check")
        self.assertTrue(call["headers"]["Authorization"].startswith("Basic "))

    def test_multipart_elsewhere_is_sent_as_json(self):
        self.request("POST", "/jira/issue/TST-1/comment", body=b"{}", headers={"Content-Type": MULTIPART})
        (call,) = self.fake.requests
        self.assertEqual(call["headers"]["Content-Type"], "application/json")
        self.assertNotIn("X-Atlassian-Token", call["headers"])

    def test_upload_keeps_the_csrf_checks(self):
        status, _, _ = self.request("POST", "/jira/issue/TST-1/attachments", body=BODY,
                                    headers={"Content-Type": MULTIPART}, proxy_header=False)
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/jira/issue/TST-1/attachments", body=BODY,
                                    headers={"Content-Type": MULTIPART, "Origin": "http://evil.test"})
        self.assertEqual(status, 403)
        self.assertEqual(self.fake.requests, [])

    def raw(self, method, path, length):
        """Declares a body of `length` bytes but sends none; returns the status."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest(method, path)
            conn.putheader("X-Jira-Lite", "1")
            conn.putheader("Content-Type", MULTIPART)
            conn.putheader("Content-Length", str(length))
            conn.endheaders()
            resp = conn.getresponse()
            resp.read()
            return resp.status, resp.getheader("Connection")
        finally:
            conn.close()

    def test_body_size_limit(self):
        for method, path in (("POST", "/jira/issue/TST-1/attachments"), ("PUT", "/jira/issue/TST-1"),
                             ("POST", "/auth/logout")):
            with self.subTest(method=method, path=path):
                self.assertEqual(self.raw(method, path, MAX_BODY + 1), (413, "close"))
        self.assertEqual(self.raw("POST", "/jira/issue/TST-1/attachments", -5)[0], 400)
        self.assertEqual(self.fake.requests, [])

    def test_body_at_the_limit_is_accepted(self):
        status, _, _ = self.request("POST", "/jira/issue/TST-1/attachments", body=b"x" * 1024,
                                    headers={"Content-Type": MULTIPART})
        self.assertEqual(status, 201)


class OAuthFilesTest(OAuthAppTestCase):
    PREFIX = "/ex/jira/%s/rest/api/3/" % CLOUD_ID

    def test_file_route_uses_the_session_and_relays_the_redirect(self):
        sid = self.sign_in()
        self.state.requests.clear()
        resp = self.request("GET", "/files/content/10500", headers={"Sec-Fetch-Site": "same-origin"},
                            session=sid, proxy_header=False)
        self.assertEqual(resp.status, 303)
        self.assertEqual(resp.headers["location"], "https://api.media.example/file/1/binary?token=short-lived")
        (call,) = [r for r in self.state.requests if r["path"].startswith("/ex/jira/")]
        self.assertEqual(call["path"], self.PREFIX + "attachment/content/10500")
        self.assertEqual(call["headers"]["Authorization"], "Bearer access-1")

    def test_file_route_without_session_is_login_required(self):
        resp = self.request("GET", "/files/content/1", headers={"Sec-Fetch-Site": "same-origin"}, proxy_header=False)
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.headers["x-jira-lite-auth"], "login")

    def test_cross_site_refused_before_session_lookup(self):
        sid = self.sign_in()
        self.state.requests.clear()
        resp = self.request("GET", "/files/content/1", headers={"Sec-Fetch-Site": "cross-site"},
                            session=sid, proxy_header=False)
        self.assertEqual(resp.status, 403)
        self.assertEqual(self.state.requests, [])

    def test_multipart_upload(self):
        sid = self.sign_in()
        self.state.requests.clear()
        resp = self.request("POST", "/jira/issue/BA-1/attachments", body=BODY,
                            headers={"Content-Type": MULTIPART, "Origin": "http://jira-lite.test:8765"}, session=sid)
        self.assertEqual(resp.status, 201)
        (call,) = [r for r in self.state.requests if r["path"].startswith("/ex/jira/")]
        self.assertEqual(call["path"], self.PREFIX + "issue/BA-1/attachments")
        self.assertEqual((call["body"], call["headers"]["Content-Type"]), (BODY, MULTIPART))
        self.assertEqual(call["headers"]["X-Atlassian-Token"], "no-check")


if __name__ == "__main__":
    unittest.main()
