"""End-to-end tests: real app server on an ephemeral port + fake Jira upstream."""

import base64
import json
import time
import unittest

from .support import PROXY_TIMEOUT, AppTestCase, closed_port_url

EXPECTED_AUTH = "Basic " + base64.b64encode(b"me@example.com:secret-token").decode()


class HostCheckTest(AppTestCase):
    def test_allowed_hosts(self):
        for host in ("localhost:%d" % self.port, "127.0.0.1:%d" % self.port):
            with self.subTest(host=host):
                status, _, _ = self.request("GET", "/", headers={"Host": host})
                self.assertEqual(status, 200)

    def test_bad_hosts_rejected_on_every_route(self):
        bad = ("evil.com", "evil.com:%d" % self.port, "localhost", "localhost:1", "LOCALHOST:%d" % self.port)
        for host in bad:
            for method, path in (("GET", "/"), ("GET", "/config"), ("GET", "/jira/myself"),
                                 ("POST", "/jira/issue"), ("PUT", "/jira/issue/X-1"),
                                 ("DELETE", "/jira/issue/X-1/comment/1")):
                with self.subTest(host=host, method=method, path=path):
                    status, headers, body = self.request(method, path, body=b"{}" if method != "GET" else None,
                                                         headers={"Host": host})
                    self.assertEqual((status, body), (403, b"bad host"))
                    self.assertEqual(headers["content-type"], "text/plain")
        self.assertEqual(self.fake.requests, [])


class ConfigEndpointTest(AppTestCase):
    def test_config_payload(self):
        status, headers, body = self.request("GET", "/config?x=1", proxy_header=False)
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(json.loads(body), {"project": "TST", "site": self.fake.url, "auth": "token"})


class TokenModeAuthTest(AppTestCase):
    def test_me_reports_token_mode(self):
        status, headers, body = self.request("GET", "/auth/me", proxy_header=False)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"auth": "token"})
        self.assertNotIn("set-cookie", headers)

    def test_oauth_routes_absent(self):
        for path in ("/oauth/login", "/oauth/callback?code=x&state=y"):
            with self.subTest(path=path):
                status, _, body = self.request("GET", path)
                self.assertEqual((status, body), (404, b"not found"))

    def test_logout_is_harmless(self):
        status, _, body = self.request("POST", "/auth/logout", body=b"")
        self.assertEqual((status, body), (204, b""))
        status, _, _ = self.request("POST", "/auth/logout", body=b"", proxy_header=False)
        self.assertEqual(status, 403)


class OriginCheckTest(AppTestCase):
    def test_foreign_origin_rejected_on_post_and_put(self):
        for origin in ("https://evil.example", "null", "http://localhost:1", "https://localhost:%d" % self.port):
            for method, path in (("POST", "/jira/issue"), ("PUT", "/jira/issue/X-1"), ("POST", "/auth/logout"),
                                 ("DELETE", "/jira/issue/X-1/comment/1")):
                with self.subTest(origin=origin, method=method, path=path):
                    status, _, body = self.request(method, path, body=b"{}", headers={"Origin": origin})
                    self.assertEqual((status, body), (403, b"bad origin"))
        self.assertEqual(self.fake.requests, [])

    def test_own_origin_or_none_allowed(self):
        for origin in (None, "http://localhost:%d" % self.port, "http://127.0.0.1:%d" % self.port):
            with self.subTest(origin=origin):
                self.fake.requests.clear()
                headers = {} if origin is None else {"Origin": origin}
                status, _, _ = self.request("POST", "/jira/issue", body=b"{}", headers=headers)
                self.assertEqual(status, 201)
                self.assertEqual(len(self.fake.requests), 1)

    def test_get_ignores_origin(self):
        status, _, _ = self.request("GET", "/config", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 200)


class ProxyTest(AppTestCase):
    def last(self):
        self.assertEqual(len(self.fake.requests), 1)
        return self.fake.requests[0]

    def test_missing_or_wrong_header_is_403(self):
        for method, path in (("GET", "/jira/myself"), ("POST", "/jira/issue"),
                             ("PUT", "/jira/issue/X-1"), ("DELETE", "/jira/issue/X-1/comment/1"),
                             ("POST", "/config")):
            for value in (None, "0", "true"):
                with self.subTest(method=method, path=path, value=value):
                    headers = {} if value is None else {"X-Jira-Lite": value}
                    status, _, body = self.request(method, path, body=b"{}" if method != "GET" else None,
                                                   headers=headers, proxy_header=False)
                    self.assertEqual((status, body), (403, b"missing X-Jira-Lite header"))
        self.assertEqual(self.fake.requests, [])

    def test_dotdot_is_400(self):
        for method, path in (("GET", "/jira/../../secret"), ("GET", "/jira/issue/..?x=1"),
                             ("POST", "/jira/issue/%2e%2e/x"), ("PUT", "/jira/a/../b"),
                             ("DELETE", "/jira/issue/X-1/comment/%2E%2E")):
            with self.subTest(method=method, path=path):
                status, _, body = self.request(method, path, body=b"{}" if method != "GET" else None)
                self.assertEqual((status, body), (400, b"bad path"))
        self.assertEqual(self.fake.requests, [])

    def test_post_put_to_non_proxy_path_is_404(self):
        for method in ("POST", "PUT", "DELETE"):
            with self.subTest(method=method):
                status, _, body = self.request(method, "/index.html", body=b"{}")
                self.assertEqual((status, body), (404, b"not found"))

    def test_unsupported_methods_not_implemented(self):
        for method in ("OPTIONS", "PATCH"):
            with self.subTest(method=method):
                status, _, _ = self.request(method, "/jira/issue/X-1")
                self.assertEqual(status, 501)
        self.assertEqual(self.fake.requests, [])

    def test_get_forwarding(self):
        status, headers, body = self.request("GET", "/jira/search/jql?jql=project%3DBA&maxResults=5")
        self.assertEqual(status, 200)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["content-length"], str(len(body)))
        req = self.last()
        self.assertEqual(req["method"], "GET")
        self.assertEqual(req["path"], "/rest/api/3/search/jql?jql=project%3DBA&maxResults=5")
        self.assertEqual(req["headers"]["Authorization"], EXPECTED_AUTH)
        self.assertEqual(req["headers"]["Accept"], "application/json")
        self.assertNotIn("Content-Type", req["headers"])
        self.assertNotIn("X-Jira-Lite", req["headers"])
        self.assertEqual(json.loads(body)["path"], req["path"])

    def test_agile_api_not_proxied(self):
        status, _, _ = self.request("GET", "/agile/board/7/sprint?state=active")
        self.assertEqual(status, 404)
        self.assertEqual(self.fake.requests, [])

    def test_post_and_put_forward_body(self):
        for method, path, upstream in (("POST", "/jira/issue/X-1/comment", "/rest/api/3/issue/X-1/comment"),
                                       ("PUT", "/jira/issue/X-1", "/rest/api/3/issue/X-1")):
            with self.subTest(method=method, path=path):
                self.fake.requests.clear()
                payload = json.dumps({"fields": {"summary": "héllo"}}).encode()
                status, _, body = self.request(method, path, body=payload,
                                               headers={"Content-Type": "text/plain"})
                self.assertEqual(status, 201)
                req = self.last()
                self.assertEqual((req["method"], req["path"], req["body"]), (method, upstream, payload))
                self.assertEqual(req["headers"]["Content-Type"], "application/json")
                self.assertEqual(req["headers"]["Authorization"], EXPECTED_AUTH)

    def test_delete_forwards_and_relays_204(self):
        status, headers, body = self.request("DELETE", "/jira/issue/X-1/comment/10042")
        self.assertEqual((status, body), (204, b""))
        self.assertNotIn("content-length", headers)
        self.assertEqual(headers["cache-control"], "no-store")
        req = self.last()
        self.assertEqual((req["method"], req["path"], req["body"]), ("DELETE", "/rest/api/3/issue/X-1/comment/10042", b""))
        self.assertEqual(req["headers"]["Authorization"], EXPECTED_AUTH)
        self.assertNotIn("Content-Type", req["headers"])

    def test_delete_error_passes_through(self):
        status, _, body = self.request("DELETE", "/jira/issue/missing")
        self.assertEqual((status, body), (404, b'{"errorMessages":["Issue does not exist"]}'))

    def test_post_without_body(self):
        status, _, _ = self.request("POST", "/jira/issue/X-1/transitions", body=b"")
        self.assertEqual(status, 201)
        req = self.last()
        self.assertEqual(req["body"], b"")
        self.assertEqual(req["headers"]["Content-Type"], "application/json")

    def test_upstream_content_type_passthrough(self):
        status, headers, body = self.request("GET", "/jira/text")
        self.assertEqual((status, body), (200, b"plain"))
        self.assertEqual(headers["content-type"], "text/plain;charset=UTF-8")

    def test_upstream_http_errors_pass_through(self):
        status, headers, body = self.request("GET", "/jira/issue/missing")
        self.assertEqual((status, body), (404, b'{"errorMessages":["Issue does not exist"]}'))
        self.assertEqual(headers["content-type"], "application/json")
        status, _, body = self.request("POST", "/jira/bad-request", body=b"{}")
        self.assertEqual((status, body), (400, b'{"errors":{"summary":"required"}}'))

    def test_upstream_timeout_is_502(self):
        start = time.monotonic()
        status, headers, body = self.request("GET", "/jira/slow")
        self.assertLess(time.monotonic() - start, PROXY_TIMEOUT + 1.0)
        self.assertEqual(status, 502)
        self.assertEqual(headers["content-type"], "application/json")
        msg = json.loads(body)["errorMessages"][0]
        self.assertTrue(msg.startswith("Proxy error: "), msg)


class UnreachableUpstreamTest(AppTestCase):
    upstream_url = closed_port_url()

    def test_unreachable_is_502(self):
        for method in ("GET", "POST", "PUT", "DELETE"):
            with self.subTest(method=method):
                status, headers, body = self.request(method, "/jira/myself",
                                                     body=b"{}" if method != "GET" else None)
                self.assertEqual(status, 502)
                self.assertEqual(headers["content-type"], "application/json")
                payload = json.loads(body)
                self.assertEqual(len(payload["errorMessages"]), 1)
                self.assertTrue(payload["errorMessages"][0].startswith("Proxy error: "))


class StaticTest(AppTestCase):
    def test_index(self):
        status, headers, body = self.request("GET", "/", proxy_header=False)
        self.assertEqual((status, body), (200, b"<!doctype html><title>index</title>"))
        self.assertEqual(headers["content-type"], "text/html; charset=utf-8")
        self.assertEqual(headers["cache-control"], "no-cache")  # revalidated every load (ETag → 304)
        self.assertTrue(headers["etag"].startswith('"'))
        self.assertEqual(headers["content-length"], str(len(body)))

    def test_etag_revalidation(self):
        _, headers, _ = self.request("GET", "/app.js", proxy_header=False)
        status, h304, body = self.request("GET", "/app.js", proxy_header=False, headers={"If-None-Match": headers["etag"]})
        self.assertEqual((status, body, h304["etag"]), (304, b"", headers["etag"]))
        self.assertEqual(self.request("GET", "/app.js", proxy_header=False, headers={"If-None-Match": '"other"'})[0], 200)

    def test_versioned_rewrite(self):
        from app.static import versioned
        js = b'import { a } from "./a.js";\nexport { b } from \'../b.js\';\nimport "./c.js";\nconst x = import("./d.js");\nconst s = "./e.js";'
        out = versioned("m.js", js, "abc").decode()
        for spec in ('"./a.js?v=abc"', "'../b.js?v=abc'", '"./c.js?v=abc"', '"./d.js?v=abc"'):
            self.assertIn(spec, out)
        self.assertIn('"./e.js"', out)  # a plain string is not an import
        html = b'<link rel="stylesheet" href="css/a.css"><script type="module" src="js/main.js"></script><a href="https://x/js/y.js">'
        out = versioned("index.html", html, "v1").decode()
        self.assertIn('href="css/a.css?v=v1"', out)
        self.assertIn('src="js/main.js?v=v1"', out)
        self.assertIn('href="https://x/js/y.js"', out)
        self.assertEqual(versioned("a.css", b"x", "v1"), b"x")

    def test_etag_matches(self):
        from app.static import etag_matches
        self.assertTrue(etag_matches('"a-1"', '"a-1"'))
        self.assertTrue(etag_matches('"x", W/"a-1"', '"a-1"'))
        self.assertTrue(etag_matches("*", '"a-1"'))
        self.assertFalse(etag_matches(None, '"a-1"'))
        self.assertFalse(etag_matches('"a-2"', '"a-1"'))

    def test_query_string_ignored(self):
        status, _, body = self.request("GET", "/app.js?v=3")
        self.assertEqual((status, body), (200, b"console.log(1)"))

    def test_content_types(self):
        expected = {
            "/index.html": "text/html; charset=utf-8",
            "/app.js": "text/javascript; charset=utf-8",
            "/css/style.css": "text/css; charset=utf-8",
            "/logo.svg": "image/svg+xml",
            "/data.json": "application/json",
            "/favicon.ico": "image/x-icon",
            "/img.png": "image/png",
            "/notes.txt": "application/octet-stream",
        }
        for path, ctype in expected.items():
            with self.subTest(path=path):
                status, headers, _ = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers["content-type"], ctype)

    def test_not_found_and_traversal(self):
        for path in ("/missing.html", "/css/", "/../server.py", "/%2e%2e/server.py", "/%2E%2E/server.py",
                     "/css/../../server.py", "/..%2fserver.py", "/../webby.txt", "/jira", "/config/"):
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path)
                self.assertEqual((status, body), (404, b"not found"))
                self.assertEqual(headers["content-type"], "text/plain")
                self.assertEqual(headers["cache-control"], "no-store")


if __name__ == "__main__":
    unittest.main()
