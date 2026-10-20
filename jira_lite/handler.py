"""HTTP request handler: Host/Origin/header checks and routing.

Routes:
  GET  /config               -> {"project", "site", "auth"} JSON
  GET  /auth/me              -> signed-in user (OAuth) or {"auth": "token"}
  POST /auth/logout          -> sign out (needs ``X-Jira-Lite: 1``)
  GET  /oauth/login          -> start "Sign in with Atlassian" (OAuth mode only)
  GET  /oauth/callback       -> finish it (OAuth mode only)
  GET|POST|PUT /jira/*       -> Jira proxy (needs ``X-Jira-Lite: 1``)
  GET  anything else         -> static file from the web root

Every request must carry an allowed ``Host`` (``localhost:PORT``,
``127.0.0.1:PORT``, configured public hosts, the base URL's host): this
blocks DNS rebinding. POST/PUT requests with an ``Origin`` header must come
from an allowed origin. Other methods (incl. CORS preflight OPTIONS) are left
unimplemented, so cross-site requests can never pass a preflight.

In OAuth mode a missing or expired session answers 401
``{"error": "login_required", ...}`` with ``X-Jira-Lite-Auth: login``, so the
frontend can tell it apart from a 401 relayed from Jira.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING, Iterable, Tuple

from . import static
from .auth import LOGIN_REQUIRED_BODY, LoginRequired, Reply
from .proxy import ProxyResponse, UnsafePathError, match_prefix

if TYPE_CHECKING:  # pragma: no cover
    from .app import JiraLiteServer

PROXY_HEADER = "X-Jira-Lite"
AUTH_HEADER = "X-Jira-Lite-Auth"
TEXT = "text/plain"
REDACTED_QUERY_PREFIXES = ("/oauth/",)  # their query strings carry codes and state


def redact_request_line(line: str) -> str:
    """Drop the query string from logged ``/oauth/*`` request lines."""
    parts = line.split(" ")
    if len(parts) >= 2 and parts[1].startswith(REDACTED_QUERY_PREFIXES) and "?" in parts[1]:
        parts[1] = parts[1].split("?", 1)[0] + "?<redacted>"
    return " ".join(parts)


class Handler(BaseHTTPRequestHandler):
    """Thin routing layer; the work happens in :mod:`proxy`, :mod:`auth` and :mod:`static`."""

    server: "JiraLiteServer"

    # -- HTTP verbs -------------------------------------------------------
    def do_GET(self) -> None:
        if not self._host_ok():
            return
        path, _, query = self.path.partition("?")
        if path == "/config":
            self._send_json(200, self.server.public_config())
        elif path == "/auth/me":
            self._auth_me()
        elif path in ("/oauth/login", "/oauth/callback") and self.server.auth is not None:
            auth = self.server.auth
            self._reply(auth.login() if path == "/oauth/login"
                        else auth.callback(query, self.headers.get("Cookie")))
        elif match_prefix(path) is not None:
            self._proxy()
        else:
            self._static(path)

    def do_POST(self) -> None:
        if not (self._host_ok() and self._origin_ok()):
            return
        if self.path.split("?")[0] == "/auth/logout":
            self._logout()
        else:
            self._proxy()

    def do_PUT(self) -> None:
        if self._host_ok() and self._origin_ok():
            self._proxy()

    # -- checks -----------------------------------------------------------
    def _host_ok(self) -> bool:
        """Only accept requests addressed to us by an allowed name (blocks DNS rebinding)."""
        if self.headers.get("Host") in self.server.allowed_hosts:
            return True
        self._send(403, b"bad host", TEXT)
        return False

    def _origin_ok(self) -> bool:
        """State-changing requests sent by a browser must come from our own origin."""
        origin = self.headers.get("Origin")
        if origin is None or origin in self.server.allowed_origins:
            return True
        self._send(403, b"bad origin", TEXT)
        return False

    def _has_proxy_header(self) -> bool:
        # A custom header forces a CORS preflight (which we never answer), so
        # other websites open in the browser can't drive these routes.
        if self.headers.get(PROXY_HEADER) == "1":
            return True
        self._send(403, b"missing X-Jira-Lite header", TEXT)
        return False

    # -- routes -----------------------------------------------------------
    def _proxy(self) -> None:
        if not self._has_proxy_header():
            return
        if match_prefix(self.path) is None:
            return self._send(404, b"not found", TEXT)
        body = self._read_body() if self.command in ("POST", "PUT") else None
        auth = self.server.auth
        try:
            if auth is None:
                result = self.server.proxy.forward(self.command, self.path, body)
            else:
                result = auth.forward(self.command, self.path, body, self.headers.get("Cookie"))
        except UnsafePathError:
            return self._send(400, b"bad path", TEXT)
        except LoginRequired:
            return self._login_required()
        self._relay(result)

    def _auth_me(self) -> None:
        if self.server.auth is None:
            return self._send_json(200, {"auth": "token"})
        try:
            self._reply(self.server.auth.me(self.headers.get("Cookie")))
        except LoginRequired:
            self._login_required()

    def _logout(self) -> None:
        if not self._has_proxy_header():
            return
        if self.server.auth is None:
            return self._send_empty(204)
        self._reply(self.server.auth.logout(self.headers.get("Cookie")))

    def _static(self, path: str) -> None:
        full = static.resolve(self.server.web_root, path)
        if full is None:
            return self._send(404, b"not found", TEXT)
        self._send(200, static.read(full), static.content_type(full))

    # -- helpers ----------------------------------------------------------
    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length)

    def _relay(self, result: ProxyResponse) -> None:
        self._send(result.status, result.body, result.content_type)

    def _login_required(self) -> None:
        self._send(401, LOGIN_REQUIRED_BODY, "application/json", ((AUTH_HEADER, "login"),))

    def _reply(self, reply: Reply) -> None:
        if reply.status == 204:
            return self._send_empty(204, reply.headers)
        self._send(reply.status, reply.body, reply.content_type, reply.headers)

    def _send_json(self, code: int, payload: object) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def _send(self, code: int, data: bytes, ctype: str,
              headers: Iterable[Tuple[str, str]] = ()) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _send_empty(self, code: int, headers: Iterable[Tuple[str, str]] = ()) -> None:
        """A bodiless response (204 must not carry Content-Length)."""
        self.send_response(code)
        self.send_header("Cache-Control", "no-store")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()

    def log_request(self, code: object = "-", size: object = "-") -> None:
        self.log_message('"%s" %s %s', redact_request_line(self.requestline), str(code), str(size))

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        if not self.server.quiet:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), format % args))
