"""A fake Atlassian (auth.atlassian.com + api.atlassian.com) and an OAuth-mode app.

The two fake servers listen on ephemeral 127.0.0.1 ports and share one
:class:`AtlassianState`, so tokens issued by the "auth" server work on the
"api" server. Refresh tokens rotate like the real thing: each refresh
invalidates the token it used, and reusing one answers ``invalid_grant``.
"""

import http.client
import json
import shutil
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

from app.app import create_server
from app.config import Settings
from app.sessions import SessionStore

from .support import make_web_root, start, stop

SITE = "https://example.atlassian.net"
CLIENT_ID = "client-id-123"
CLIENT_SECRET = "client-secret-xyz"
BASE_URL = "http://jira-lite.test:8765"
GOOD_CODE = "good-code"
CLOUD_ID = "cloud-123"
ACCOUNT_ID = "acct-1"
DISPLAY_NAME = "Ada Lovelace"


class AtlassianState:
    """Shared, inspectable state of the fake auth + API servers."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.requests = []  # type: List[Dict[str, Any]]
            self.counter = 0
            self.valid_access = set()  # type: set
            self.valid_refresh = set()  # type: set
            self.refresh_count = 0
            self.refresh_delay = 0.0
            self.refresh_status = 0  # when set, refreshes answer this status (e.g. 429 rate limited)
            self.reject_all_access = False  # API answers 401 to every token (app access revoked)
            self.expires_in = 3600
            self.resources = [{"id": "other-cloud", "url": "https://other.atlassian.net", "name": "other"},
                              {"id": CLOUD_ID, "url": SITE, "name": "example"}]

    def issue(self) -> Dict[str, Any]:
        with self.lock:
            self.counter += 1
            access, refresh = "access-%d" % self.counter, "refresh-%d" % self.counter
            self.valid_access.add(access)
            self.valid_refresh.add(refresh)
            return {"access_token": access, "refresh_token": refresh, "expires_in": self.expires_in,
                    "token_type": "Bearer", "scope": "read:jira-work"}

    def token_requests(self) -> List[Dict[str, Any]]:
        return [r for r in self.requests if r["path"] == "/oauth/token"]


class _Handler(BaseHTTPRequestHandler):
    server: "FakeAtlassian"

    def _handle(self) -> None:
        state = self.server.state
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        with state.lock:
            state.requests.append({"server": self.server.role, "method": self.command, "path": self.path,
                                   "headers": dict(self.headers.items()), "body": raw})
        path = self.path.split("?")[0]
        if path == "/oauth/token" and self.command == "POST":
            return self._token(json.loads(raw.decode() or "{}"))
        bearer = (self.headers.get("Authorization") or "")[len("Bearer "):]
        with state.lock:
            authorised = self.headers.get("Authorization", "").startswith("Bearer ") and bearer in state.valid_access
            authorised = authorised and not state.reject_all_access
        if not authorised:
            return self._json(401, {"code": 401, "message": "Unauthorized"})
        if path == "/oauth/token/accessible-resources":
            return self._json(200, state.resources)
        prefix = "/ex/jira/%s/rest/api/3/" % CLOUD_ID
        if not path.startswith(prefix):
            return self._json(404, {"errorMessages": ["no such site"]})
        if path.startswith(prefix + "attachment/content/"):
            self.send_response(303)
            self.send_header("Location", "https://api.media.example/file/1/binary?token=short-lived")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == prefix + "myself":
            return self._json(200, {"accountId": ACCOUNT_ID, "displayName": DISPLAY_NAME})
        if self.command == "DELETE":
            self.send_response(204)
            self.end_headers()
            return
        self._json(200 if self.command == "GET" else 201,
                   {"method": self.command, "path": self.path, "auth": self.headers.get("Authorization")})

    do_GET = do_POST = do_PUT = do_DELETE = _handle

    def _token(self, form: Dict[str, Any]) -> None:
        state = self.server.state
        if form.get("client_id") != CLIENT_ID or form.get("client_secret") != CLIENT_SECRET:
            return self._json(401, {"error": "access_denied"})
        grant = form.get("grant_type")
        if grant == "authorization_code":
            if form.get("code") != GOOD_CODE or form.get("redirect_uri") != BASE_URL + "/oauth/callback":
                return self._json(403, {"error": "invalid_grant"})
            return self._json(200, state.issue())
        if grant == "refresh_token":
            time.sleep(state.refresh_delay)
            if state.refresh_status:
                return self._json(state.refresh_status, {"error": "rate_limited"})
            with state.lock:
                token = form.get("refresh_token")
                if token not in state.valid_refresh:
                    return self._json(403, {"error": "invalid_grant",
                                            "error_description": "Unknown or invalid refresh token."})
                state.valid_refresh.discard(token)  # rotation: single use
                state.refresh_count += 1
            return self._json(200, state.issue())
        self._json(400, {"error": "unsupported_grant_type"})

    def _json(self, code: int, payload: Any) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


class FakeAtlassian(ThreadingHTTPServer):
    """One of the two fake hosts ("auth" or "api")."""

    daemon_threads = True

    def __init__(self, state: AtlassianState, role: str) -> None:
        self.state = state
        self.role = role
        super().__init__(("127.0.0.1", 0), _Handler)

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.server_address[1]


class Response:
    def __init__(self, status: int, headers: List[Tuple[str, str]], body: bytes) -> None:
        self.status = status
        self.header_list = headers
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body

    def cookies(self) -> List[str]:
        """All Set-Cookie values, in order."""
        return [v for k, v in self.header_list if k.lower() == "set-cookie"]

    def cookie(self, name: str) -> Optional[str]:
        """The full Set-Cookie line for ``name``, if set."""
        return next((c for c in self.cookies() if c.startswith(name + "=")), None)

    def json(self) -> Any:
        return json.loads(self.body)


class OAuthAppTestCase(unittest.TestCase):
    """A real app server in OAuth mode against the fake Atlassian."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.state = AtlassianState()
        cls.auth_server = FakeAtlassian(cls.state, "auth")
        cls.api_server = FakeAtlassian(cls.state, "api")
        cls.threads = [start(cls.auth_server), start(cls.api_server)]
        cls.tmp, cls.web = make_web_root()
        settings = Settings(site=SITE, project="TST", port=0, timeout=5.0,
                            oauth_client_id=CLIENT_ID, oauth_client_secret=CLIENT_SECRET,
                            base_url=BASE_URL, atlassian_auth_url=cls.auth_server.url,
                            atlassian_api_url=cls.api_server.url)
        cls.app = create_server(settings, web_root=cls.web, quiet=True)
        cls.app_thread = start(cls.app)
        cls.port = cls.app.port

    @classmethod
    def tearDownClass(cls) -> None:
        stop(cls.app, cls.app_thread)
        stop(cls.auth_server, cls.threads[0])
        stop(cls.api_server, cls.threads[1])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        self.state.reset()
        self.app.auth.store = SessionStore()

    def request(self, method: str, path: str, body: Optional[bytes] = None,
                headers: Optional[Dict[str, str]] = None, session: Optional[str] = None,
                proxy_header: bool = True) -> Response:
        hdrs = dict(headers or {})
        if proxy_header:
            hdrs.setdefault("X-Jira-Lite", "1")
        if session is not None:
            hdrs["Cookie"] = "jl_session=" + session
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=hdrs)
            resp = conn.getresponse()
            return Response(resp.status, resp.getheaders(), resp.read())
        finally:
            conn.close()

    def start_login(self) -> Tuple[str, Dict[str, List[str]]]:
        """GET /oauth/login; returns (state cookie value, authorize query params)."""
        resp = self.request("GET", "/oauth/login", proxy_header=False)
        self.assertEqual(resp.status, 302)
        state_cookie = resp.cookie("jl_oauth_state")
        self.assertIsNotNone(state_cookie)
        value = state_cookie.split(";")[0].split("=", 1)[1]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(resp.headers["location"]).query)
        return value, query

    def callback(self, query: str, state_cookie: Optional[str]) -> Response:
        headers = {} if state_cookie is None else {"Cookie": "jl_oauth_state=" + state_cookie}
        return self.request("GET", "/oauth/callback?" + query, headers=headers, proxy_header=False)

    def sign_in(self) -> str:
        """Full happy-path sign-in; returns the jl_session cookie value."""
        state, _ = self.start_login()
        resp = self.callback(urllib.parse.urlencode({"code": GOOD_CODE, "state": state}), state)
        self.assertEqual(resp.status, 302, resp.body)
        line = resp.cookie("jl_session")
        self.assertIsNotNone(line)
        return line.split(";")[0].split("=", 1)[1]

    def session(self, session_id: str):
        """The server-side session object (without touching last_seen semantics much)."""
        return self.app.auth.store.get(session_id)
