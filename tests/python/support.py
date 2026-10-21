"""Test helpers: a fake Jira upstream and a running jira-lite app server.

Both servers listen on ephemeral 127.0.0.1 ports in background threads, so
tests never touch the real Jira.
"""

import http.client
import json
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, Optional, Tuple

from app.app import create_server
from app.config import Settings

SLOW_SECONDS = 2.0  # how long the fake's /slow endpoint stalls
PROXY_TIMEOUT = 0.5  # proxy timeout used by the app under test
MEDIA_PATH = "/media/file/"  # where the fake redirects attachment downloads
MEDIA_UUID = "cebf256e-58b9-4541-82f2-13ab1ef4a0d2"  # attachment 10601's media file (Jira's real URL shape)
PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"


class _FakeJiraHandler(BaseHTTPRequestHandler):
    """Records every request and answers a few canned endpoints."""

    server: "FakeJira"

    def _handle(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self.server.requests.append({
            "method": self.command,
            "path": self.path,
            "headers": dict(self.headers.items()),
            "body": body,
        })
        path = self.path.split("?")[0]
        if path.endswith("/slow"):
            time.sleep(SLOW_SECONDS)
            return self._reply(200, b"{}")
        if path.endswith("/missing"):
            return self._reply(404, b'{"errorMessages":["Issue does not exist"]}')
        if path.endswith("/text"):
            return self._reply(200, b"plain", "text/plain;charset=UTF-8")
        if path.endswith("/bad-request"):
            return self._reply(400, b'{"errors":{"summary":"required"}}')
        if "/attachment/content/" in path:  # Jira Cloud: 303 to a short-lived media URL
            att = path.rsplit("/", 1)[1]
            if att == "10601":
                return self._redirect(MEDIA_PATH + MEDIA_UUID + "/binary?token=short-lived&name=a.png")
            if att == "10602":  # some answer with the bytes directly
                return self._reply(200, b"<html>not json</html>", "text/html")
            return self._redirect(MEDIA_PATH + att + "?token=short-lived")
        if "/attachment/thumbnail/" in path:  # some answers carry the bytes directly
            return self._reply(200, PNG_BYTES, "image/png", (("Content-Disposition", 'inline; filename="a.png"'),))
        if path.startswith(MEDIA_PATH):  # must never be reached through the proxy
            return self._reply(200, b"media bytes", "application/octet-stream")
        if self.command == "DELETE":
            return self._reply_empty(204)
        payload = {"method": self.command, "path": self.path}
        self._reply(200 if self.command == "GET" else 201, json.dumps(payload).encode())

    do_GET = do_POST = do_PUT = do_DELETE = _handle

    def _reply_empty(self, code: int) -> None:
        self.send_response(code)
        self.end_headers()

    def _redirect(self, path: str) -> None:
        self.send_response(303)
        self.send_header("Location", self.server.url + path)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _reply(self, code: int, data: bytes, ctype: str = "application/json",
               headers: Tuple[Tuple[str, str], ...] = ()) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass  # client (the proxy) gave up, e.g. after a timeout

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


class FakeJira(ThreadingHTTPServer):
    """In-process stand-in for Jira Cloud."""

    daemon_threads = True

    def __init__(self) -> None:
        self.requests = []  # type: List[Dict[str, object]]
        super().__init__(("127.0.0.1", 0), _FakeJiraHandler)

    @property
    def url(self) -> str:
        return "http://127.0.0.1:%d" % self.server_address[1]


def start(server: ThreadingHTTPServer) -> threading.Thread:
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
    thread.daemon = True
    thread.start()
    return thread


def stop(server: ThreadingHTTPServer, thread: threading.Thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def closed_port_url() -> str:
    """URL of a localhost port with nothing listening."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    return "http://127.0.0.1:%d" % port


def make_web_root() -> Tuple[str, str]:
    """Create ``<tmp>/web`` with a few files and a secret beside it.

    Returns (tmp_dir, web_root)."""
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="jira-lite-test-"))
    web = os.path.join(tmp, "web")
    os.makedirs(os.path.join(web, "css"))
    files = {
        "index.html": b"<!doctype html><title>index</title>",
        "app.js": b"console.log(1)",
        "css/style.css": b"body{}",
        "logo.svg": b"<svg/>",
        "data.json": b"{}",
        "favicon.ico": b"\x00\x00",
        "img.png": b"\x89PNG",
        "notes.txt": b"txt",
        "with space.html": b"spaced",
    }
    for name, data in files.items():
        with open(os.path.join(web, name), "wb") as f:
            f.write(data)
    with open(os.path.join(tmp, "server.py"), "w") as f:
        f.write("SECRET = 'outside web root'\n")
    with open(os.path.join(tmp, "webby.txt"), "w") as f:
        f.write("sibling prefix")
    return tmp, web


class AppTestCase(unittest.TestCase):
    """Starts a fake Jira and a real app server per test class."""

    upstream_url = None  # type: Optional[str]  # override for unreachable upstreams

    @classmethod
    def setUpClass(cls) -> None:
        cls.fake = FakeJira()
        cls.fake_thread = start(cls.fake)
        cls.tmp, cls.web = make_web_root()
        settings = Settings(
            site=cls.upstream_url or cls.fake.url,
            email="me@example.com",
            token="secret-token",
            project="TST",
            port=0,
            timeout=PROXY_TIMEOUT,
        )
        cls.app = create_server(settings, web_root=cls.web, quiet=True)
        cls.app_thread = start(cls.app)
        cls.port = cls.app.port

    @classmethod
    def tearDownClass(cls) -> None:
        stop(cls.app, cls.app_thread)
        stop(cls.fake, cls.fake_thread)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        self.fake.requests.clear()

    def request(self, method: str, path: str, body: Optional[bytes] = None,
                headers: Optional[Dict[str, str]] = None,
                proxy_header: bool = True) -> Tuple[int, Dict[str, str], bytes]:
        """Send a raw request to the app; returns (status, headers, body)."""
        hdrs = dict(headers or {})
        if proxy_header:
            hdrs.setdefault("X-Jira-Lite", "1")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=hdrs)
            resp = conn.getresponse()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
        finally:
            conn.close()
