"""HTTP request handler: Host/header checks and routing.

Routes:
  GET  /config               -> {"project", "site", "board"} JSON
  GET|POST|PUT /jira/*, /agile/* -> Jira proxy (needs ``X-Jira-Lite: 1``)
  GET  anything else         -> static file from the web root

Every request must carry ``Host: localhost:PORT`` or ``127.0.0.1:PORT``
(DNS-rebinding protection). Other methods (incl. CORS preflight OPTIONS)
are left unimplemented, so cross-site requests can never pass a preflight.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING

from . import static
from .proxy import ProxyResponse, UnsafePathError, match_prefix

if TYPE_CHECKING:  # pragma: no cover
    from .app import JiraLiteServer

PROXY_HEADER = "X-Jira-Lite"
TEXT = "text/plain"


class Handler(BaseHTTPRequestHandler):
    """Thin routing layer; the work happens in :mod:`proxy` and :mod:`static`."""

    server: "JiraLiteServer"

    # -- HTTP verbs -------------------------------------------------------
    def do_GET(self) -> None:
        if not self._host_ok():
            return
        path = self.path.split("?")[0]
        if path == "/config":
            self._send_json(200, self.server.public_config())
        elif match_prefix(path) is not None:
            self._proxy()
        else:
            self._static(path)

    def do_POST(self) -> None:
        if self._host_ok():
            self._proxy()

    def do_PUT(self) -> None:
        if self._host_ok():
            self._proxy()

    # -- checks -----------------------------------------------------------
    def _host_ok(self) -> bool:
        """Only accept requests addressed to localhost (blocks DNS rebinding)."""
        if self.headers.get("Host") in self.server.allowed_hosts:
            return True
        self._send(403, b"bad host", TEXT)
        return False

    # -- routes -----------------------------------------------------------
    def _proxy(self) -> None:
        # A custom header forces a CORS preflight (which we never answer), so
        # other websites open in the browser can't drive this proxy.
        if self.headers.get(PROXY_HEADER) != "1":
            return self._send(403, b"missing X-Jira-Lite header", TEXT)
        if match_prefix(self.path) is None:
            return self._send(404, b"not found", TEXT)
        body = self._read_body() if self.command in ("POST", "PUT") else None
        try:
            result = self.server.proxy.forward(self.command, self.path, body)
        except UnsafePathError:
            return self._send(400, b"bad path", TEXT)
        self._relay(result)

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

    def _send_json(self, code: int, payload: object) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def _send(self, code: int, data: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        if not self.server.quiet:
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), format % args))

