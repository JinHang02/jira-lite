"""End-to-end tests for OAuth mode: app server + fake Atlassian (no network)."""

import json
import threading
import time
import unittest
import urllib.parse

from app.app import oauth_service
from app.config import Settings
from app.handler import redact_request_line

from .atlassian_fake import (ACCOUNT_ID, BASE_URL, CLIENT_ID, CLIENT_SECRET, CLOUD_ID, DISPLAY_NAME,
                             GOOD_CODE, SITE, OAuthAppTestCase)

LOGIN_REQUIRED = {"error": "login_required", "login": "/oauth/login"}
JIRA_PREFIX = "/ex/jira/%s/rest/api/3/" % CLOUD_ID


class LoginTest(OAuthAppTestCase):
    def test_config_reports_oauth(self):
        resp = self.request("GET", "/config", proxy_header=False)
        self.assertEqual(resp.json(), {"project": "TST", "site": SITE, "auth": "oauth"})

    def test_login_redirects_to_atlassian(self):
        resp = self.request("GET", "/oauth/login", proxy_header=False)
        self.assertEqual(resp.status, 302)
        location = urllib.parse.urlsplit(resp.headers["location"])
        self.assertEqual("%s://%s%s" % (location.scheme, location.netloc, location.path),
                         self.auth_server.url + "/authorize")
        params = urllib.parse.parse_qs(location.query)
        state = params.pop("state")[0]
        self.assertEqual(params, {
            "audience": ["api.atlassian.com"],
            "client_id": [CLIENT_ID],
            "scope": ["read:jira-work write:jira-work read:jira-user offline_access"],
            "redirect_uri": [BASE_URL + "/oauth/callback"],
            "response_type": ["code"],
            "prompt": ["consent"],
        })
        self.assertNotIn("+", location.query)  # spaces encoded as %20
        self.assertGreaterEqual(len(state), 32)
        cookie = resp.cookie("jl_oauth_state")
        self.assertTrue(cookie.startswith("jl_oauth_state=%s;" % state), cookie)
        for attr in ("HttpOnly", "SameSite=Lax", "Max-Age=600", "Path=/oauth"):
            self.assertIn(attr, cookie)
        self.assertNotIn("Secure", cookie)  # plain HTTP in tests
        self.assertNotIn(CLIENT_SECRET, resp.headers["location"])
        # A second login gets a different state.
        self.assertNotEqual(self.start_login()[0], state)

    def test_callback_happy_path(self):
        state, _ = self.start_login()
        resp = self.callback(urllib.parse.urlencode({"code": GOOD_CODE, "state": state}), state)
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.headers["location"], "/")
        session_cookie = resp.cookie("jl_session")
        for attr in ("HttpOnly", "SameSite=Lax", "Path=/"):
            self.assertIn(attr, session_cookie)
        self.assertIn("Max-Age=0", resp.cookie("jl_oauth_state"))  # state is single use
        session_id = session_cookie.split(";")[0].split("=", 1)[1]
        self.assertGreaterEqual(len(session_id), 40)
        self.assertNotIn("access-", session_cookie)
        session = self.session(session_id)
        self.assertEqual((session.cloud_id, session.account_id, session.display_name),
                         (CLOUD_ID, ACCOUNT_ID, DISPLAY_NAME))
        self.assertEqual((session.access_token, session.refresh_token), ("access-1", "refresh-1"))
        self.assertNotIn("access-1", repr(session))
        # Token exchange went to the auth host with the expected JSON.
        token_req = self.state.token_requests()[0]
        self.assertEqual(token_req["server"], "auth")
        self.assertEqual(json.loads(token_req["body"]), {
            "grant_type": "authorization_code", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
            "code": GOOD_CODE, "redirect_uri": BASE_URL + "/oauth/callback"})
        api_paths = [(r["server"], r["path"], r["headers"]["Authorization"])
                     for r in self.state.requests if r["path"] != "/oauth/token"]
        self.assertEqual(api_paths, [("api", "/oauth/token/accessible-resources", "Bearer access-1"),
                                     ("api", JIRA_PREFIX + "myself", "Bearer access-1")])
        # And the browser is now signed in.
        me = self.request("GET", "/auth/me", session=session_id, proxy_header=False)
        self.assertEqual(me.status, 200)
        self.assertEqual(me.json(), {"accountId": ACCOUNT_ID, "displayName": DISPLAY_NAME, "auth": "oauth"})

    def test_bad_or_missing_state_is_rejected(self):
        state, _ = self.start_login()
        cases = (
            ("wrong state", {"code": GOOD_CODE, "state": "x" + state}, state),
            ("missing state param", {"code": GOOD_CODE}, state),
            ("missing state cookie", {"code": GOOD_CODE, "state": state}, None),
            ("empty both", {"code": GOOD_CODE, "state": ""}, ""),
        )
        for label, params, cookie in cases:
            with self.subTest(label):
                resp = self.callback(urllib.parse.urlencode(params), cookie)
                self.assertEqual(resp.status, 400)
                self.assertIsNone(resp.cookie("jl_session"))
                self.assertIn(b'href="/oauth/login"', resp.body)
        self.assertEqual(len(self.app.auth.store), 0)
        self.assertEqual(self.state.token_requests(), [])  # code never redeemed

    def test_access_denied_page(self):
        state, _ = self.start_login()
        resp = self.callback("error=access_denied&error_description=User+said+no&state=" + state, state)
        self.assertEqual(resp.status, 403)
        self.assertTrue(resp.headers["content-type"].startswith("text/html"))
        self.assertIn(b"Try again", resp.body)
        self.assertIn(b'href="/oauth/login"', resp.body)
        self.assertIsNone(resp.cookie("jl_session"))
        self.assertEqual(self.state.requests, [])

    def test_other_errors_are_escaped(self):
        state, _ = self.start_login()
        resp = self.callback(urllib.parse.urlencode(
            {"error": "server_error", "error_description": "<script>alert(1)</script>", "state": state}), state)
        self.assertEqual(resp.status, 400)
        self.assertNotIn(b"<script>", resp.body)
        self.assertIn(b"&lt;script&gt;", resp.body)

    def test_bad_code_shows_error(self):
        state, _ = self.start_login()
        resp = self.callback(urllib.parse.urlencode({"code": "nope", "state": state}), state)
        self.assertEqual(resp.status, 502)
        self.assertIn(b"invalid_grant", resp.body)
        self.assertNotIn(CLIENT_SECRET.encode(), resp.body)
        self.assertIsNone(resp.cookie("jl_session"))
        self.assertEqual(len(self.app.auth.store), 0)

    def test_site_not_accessible(self):
        self.state.resources = [{"id": "other-cloud", "url": "https://other.atlassian.net", "name": "o"}]
        state, _ = self.start_login()
        resp = self.callback(urllib.parse.urlencode({"code": GOOD_CODE, "state": state}), state)
        self.assertEqual(resp.status, 403)
        self.assertIn(b"no access to " + SITE.encode(), resp.body)
        self.assertIsNone(resp.cookie("jl_session"))
        self.assertEqual(len(self.app.auth.store), 0)

    def test_base_url_host_is_allowed(self):
        resp = self.request("GET", "/config", headers={"Host": "jira-lite.test:8765"})
        self.assertEqual(resp.status, 200)
        resp = self.request("GET", "/config", headers={"Host": "jira-lite.test:1"})
        self.assertEqual(resp.status, 403)

    def test_callback_query_not_logged(self):
        line = redact_request_line("GET /oauth/callback?code=secret-code&state=s HTTP/1.1")
        self.assertEqual(line, "GET /oauth/callback?<redacted> HTTP/1.1")
        self.assertEqual(redact_request_line("GET /jira/search?jql=x HTTP/1.1"),
                         "GET /jira/search?jql=x HTTP/1.1")


class SessionRoutesTest(OAuthAppTestCase):
    def test_me_without_session(self):
        for cookie in (None, "", "forged-session-id"):
            with self.subTest(cookie=cookie):
                resp = self.request("GET", "/auth/me", session=cookie, proxy_header=False)
                self.assertEqual(resp.status, 401)
                self.assertEqual(resp.json(), LOGIN_REQUIRED)

    def test_logout(self):
        sid = self.sign_in()
        resp = self.request("POST", "/auth/logout", body=b"", session=sid, proxy_header=False)
        self.assertEqual(resp.status, 403)  # needs X-Jira-Lite
        self.assertIsNotNone(self.session(sid))
        resp = self.request("POST", "/auth/logout", body=b"", session=sid)
        self.assertEqual((resp.status, resp.body), (204, b""))
        cookie = resp.cookie("jl_session")
        self.assertIn("Max-Age=0", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIsNone(self.session(sid))
        self.assertEqual(self.request("GET", "/auth/me", session=sid).status, 401)
        self.assertEqual(self.request("GET", "/jira/myself", session=sid).status, 401)

    def test_logout_rejects_foreign_origin(self):
        sid = self.sign_in()
        resp = self.request("POST", "/auth/logout", body=b"", session=sid,
                            headers={"Origin": "https://evil.example"})
        self.assertEqual(resp.status, 403)
        self.assertIsNotNone(self.session(sid))
        resp = self.request("POST", "/auth/logout", body=b"", session=sid, headers={"Origin": BASE_URL})
        self.assertEqual(resp.status, 204)


class OAuthProxyTest(OAuthAppTestCase):
    def jira_calls(self):
        return [r for r in self.state.requests if r["path"].startswith("/ex/jira/")]

    def test_proxy_uses_bearer_and_cloud_path(self):
        sid = self.sign_in()
        self.state.requests.clear()
        resp = self.request("GET", "/jira/search/jql?jql=project%3DBA&maxResults=5", session=sid)
        self.assertEqual(resp.status, 200)
        (call,) = self.jira_calls()
        self.assertEqual(call["server"], "api")
        self.assertEqual(call["path"], JIRA_PREFIX + "search/jql?jql=project%3DBA&maxResults=5")
        self.assertEqual(call["headers"]["Authorization"], "Bearer access-1")
        self.assertNotIn("Cookie", call["headers"])
        self.assertNotIn("X-Jira-Lite", call["headers"])

    def test_proxy_post_put_forward_body(self):
        sid = self.sign_in()
        for method in ("POST", "PUT"):
            with self.subTest(method=method):
                self.state.requests.clear()
                resp = self.request(method, "/jira/issue/X-1", body=b'{"a":1}', session=sid)
                self.assertEqual(resp.status, 201)
                (call,) = self.jira_calls()
                self.assertEqual((call["method"], call["body"]), (method, b'{"a":1}'))
                self.assertEqual(call["headers"]["Content-Type"], "application/json")

    def test_proxy_delete_uses_bearer(self):
        sid = self.sign_in()
        self.state.requests.clear()
        resp = self.request("DELETE", "/jira/issue/X-1/comment/7", session=sid)
        self.assertEqual((resp.status, resp.body), (204, b""))
        (call,) = self.jira_calls()
        self.assertEqual((call["method"], call["path"], call["body"]), ("DELETE", JIRA_PREFIX + "issue/X-1/comment/7", b""))
        self.assertEqual(call["headers"]["Authorization"], "Bearer access-1")
        self.assertNotIn("Cookie", call["headers"])

    def test_delete_rejects_foreign_origin(self):
        sid = self.sign_in()
        self.state.requests.clear()
        resp = self.request("DELETE", "/jira/issue/X-1/comment/7", session=sid,
                            headers={"Origin": "https://evil.example"})
        self.assertEqual((resp.status, resp.body), (403, b"bad origin"))
        self.assertEqual(self.state.requests, [])

    def test_missing_session_is_login_required(self):
        for sid in (None, "unknown"):
            for method in ("GET", "POST", "PUT", "DELETE"):
                with self.subTest(sid=sid, method=method):
                    resp = self.request(method, "/jira/myself", session=sid,
                                        body=b"{}" if method != "GET" else None)
                    self.assertEqual(resp.status, 401)
                    self.assertEqual(resp.headers["x-jira-lite-auth"], "login")
                    self.assertEqual(resp.json(), LOGIN_REQUIRED)
        self.assertEqual(self.state.requests, [])

    def test_existing_proxy_rules_still_apply(self):
        sid = self.sign_in()
        self.state.requests.clear()
        self.assertEqual(self.request("GET", "/jira/myself", session=sid, proxy_header=False).status, 403)
        resp = self.request("GET", "/jira/../../secret", session=sid)
        self.assertEqual((resp.status, resp.body), (400, b"bad path"))
        resp = self.request("GET", "/jira/a/%2e%2e/b")  # unsafe even without a session
        self.assertEqual(resp.status, 400)
        self.assertEqual(self.request("PATCH", "/jira/issue/X-1", session=sid).status, 501)
        self.assertEqual(self.state.requests, [])

    def test_jira_401_passes_through_without_login_header_after_retry(self):
        sid = self.sign_in()
        self.state.reject_all_access = True  # e.g. the user revoked the app's access
        self.state.requests.clear()
        resp = self.request("GET", "/jira/myself", session=sid)
        self.assertEqual(resp.status, 401)
        self.assertNotIn("x-jira-lite-auth", resp.headers)
        self.assertEqual(self.state.refresh_count, 1)  # refreshed and retried exactly once
        self.assertEqual(len(self.jira_calls()), 2)


class RefreshTest(OAuthAppTestCase):
    def expire(self, sid, seconds_left=10.0):
        self.session(sid).expires_at = time.time() + seconds_left

    def test_refresh_before_expiry_stores_rotated_token(self):
        sid = self.sign_in()
        for round_no in (1, 2):  # second round only works if the rotated token was stored
            with self.subTest(round=round_no):
                self.expire(sid)
                self.state.requests.clear()
                resp = self.request("GET", "/jira/myself", session=sid)
                self.assertEqual(resp.status, 200)
                (refresh_req,) = self.state.token_requests()
                self.assertEqual(json.loads(refresh_req["body"]), {
                    "grant_type": "refresh_token", "client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                    "refresh_token": "refresh-%d" % round_no})
                session = self.session(sid)
                new = round_no + 1
                self.assertEqual((session.access_token, session.refresh_token),
                                 ("access-%d" % new, "refresh-%d" % new))
                self.assertGreater(session.expires_at, time.time() + 3000)
                call = [r for r in self.state.requests if r["path"].startswith("/ex/jira/")][0]
                self.assertEqual(call["headers"]["Authorization"], "Bearer access-%d" % new)
        self.assertEqual(self.state.refresh_count, 2)

    def test_no_refresh_while_token_is_fresh(self):
        sid = self.sign_in()
        for _ in range(3):
            self.assertEqual(self.request("GET", "/jira/myself", session=sid).status, 200)
        self.assertEqual(self.state.refresh_count, 0)

    def test_concurrent_requests_refresh_once(self):
        sid = self.sign_in()
        self.expire(sid, seconds_left=-5)  # already expired
        self.state.refresh_delay = 0.3
        self.state.requests.clear()
        results = []
        lock = threading.Lock()

        def worker():
            resp = self.request("GET", "/jira/myself", session=sid)
            with lock:
                results.append(resp.status)

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        self.assertEqual(results, [200] * 6)
        self.assertEqual(self.state.refresh_count, 1)
        self.assertEqual(len(self.state.token_requests()), 1)
        auths = {r["headers"]["Authorization"] for r in self.state.requests if r["path"].startswith("/ex/")}
        self.assertEqual(auths, {"Bearer access-2"})

    def test_upstream_401_refreshes_and_retries_once(self):
        sid = self.sign_in()
        self.state.valid_access.discard("access-1")  # revoked although not expired
        self.state.requests.clear()
        resp = self.request("POST", "/jira/issue", body=b'{"x":1}', session=sid)
        self.assertEqual(resp.status, 201)
        calls = [(r["headers"]["Authorization"], r["body"]) for r in self.state.requests
                 if r["path"].startswith("/ex/")]
        self.assertEqual(calls, [("Bearer access-1", b'{"x":1}'), ("Bearer access-2", b'{"x":1}')])
        self.assertEqual(self.state.refresh_count, 1)
        self.assertEqual(self.session(sid).refresh_token, "refresh-2")

    def test_invalid_grant_drops_session(self):
        sid = self.sign_in()
        self.expire(sid)
        self.state.valid_refresh.clear()  # refresh token revoked / expired
        resp = self.request("GET", "/jira/myself", session=sid)
        self.assertEqual(resp.status, 401)
        self.assertEqual(resp.headers["x-jira-lite-auth"], "login")
        self.assertEqual(resp.json(), LOGIN_REQUIRED)
        self.assertIsNone(self.session(sid))
        self.assertEqual(self.request("GET", "/auth/me", session=sid).status, 401)

    def test_transient_refresh_failure_keeps_valid_token(self):
        sid = self.sign_in()
        self.expire(sid, seconds_left=30)  # inside the refresh margin but still valid
        auth_url = self.app.auth.client.auth_url
        self.app.auth.client.auth_url = "http://127.0.0.1:9"  # nothing listens there
        try:
            resp = self.request("GET", "/jira/myself", session=sid)
        finally:
            self.app.auth.client.auth_url = auth_url
        self.assertEqual(resp.status, 200)
        self.assertEqual(self.session(sid).access_token, "access-1")


class SecureCookieTest(unittest.TestCase):
    def test_cookies_are_secure_over_https(self):
        settings = Settings(site=SITE, oauth_client_id=CLIENT_ID, oauth_client_secret=CLIENT_SECRET,
                            base_url="https://192.168.0.113:8765", tls_cert="c.pem", tls_key="k.pem")
        service = oauth_service(settings)
        cookies = [v for k, v in service.login().headers if k == "Set-Cookie"]
        cookies += [v for k, v in service.logout(None).headers if k == "Set-Cookie"]
        self.assertEqual(len(cookies), 2)
        for cookie in cookies:
            self.assertTrue(cookie.endswith("; Secure"), cookie)
        location = dict(service.login().headers)["Location"]
        self.assertTrue(location.startswith("https://auth.atlassian.com/authorize?"), location)
        self.assertIn("redirect_uri=https%3A%2F%2F192.168.0.113%3A8765%2Foauth%2Fcallback", location)


if __name__ == "__main__":
    unittest.main()
