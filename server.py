#!/usr/bin/env python3
"""jira-lite: serves index.html and proxies /jira/* to the Jira Cloud REST API.

Standard library only. Run: python3 server.py  (then open http://localhost:8765)
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8765"))
TIMEOUT = 20  # seconds per Jira request
PROXY_PREFIX = "/jira/"  # /jira/<path> -> {JIRA_SITE}/rest/api/3/<path>


def load_env(path):
    env = {}
    if not os.path.exists(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = {**load_env(os.path.join(HERE, ".env")), **{k: v for k, v in os.environ.items() if k.startswith("JIRA_")}}
missing = [k for k in ("JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN") if not ENV.get(k)]
if missing:
    sys.exit("Missing %s. Copy .env.example to .env and fill it in." % ", ".join(missing))

SITE = ENV["JIRA_SITE"].rstrip("/")
PROJECT = ENV.get("JIRA_PROJECT", "BA")
AUTH = "Basic " + base64.b64encode(("%s:%s" % (ENV["JIRA_EMAIL"], ENV["JIRA_TOKEN"])).encode()).decode()
ALLOWED_HOSTS = {"localhost:%d" % PORT, "127.0.0.1:%d" % PORT}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self._host_ok():
            return
        if self.path.split("?")[0] in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                self._send(200, f.read(), "text/html; charset=utf-8")
        elif self.path == "/config":
            self._send(200, json.dumps({"project": PROJECT, "site": SITE}).encode(), "application/json")
        elif self.path.startswith(PROXY_PREFIX):
            self._proxy()
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        if not self._host_ok():
            return
        if self.path.startswith(PROXY_PREFIX):
            self._proxy()
        else:
            self._send(404, b"not found", "text/plain")

    def _host_ok(self):
        # Blocks DNS-rebinding: only accept requests addressed to localhost.
        if self.headers.get("Host") in ALLOWED_HOSTS:
            return True
        self._send(403, b"bad host", "text/plain")
        return False

    def _proxy(self):
        # A custom header forces a CORS preflight (which we never answer), so other
        # websites open in the browser can't make this proxy act on Jira for them.
        if self.headers.get("X-Jira-Lite") != "1":
            return self._send(403, b"missing X-Jira-Lite header", "text/plain")
        rest = self.path[len(PROXY_PREFIX):]
        if ".." in rest.split("?")[0]:
            return self._send(400, b"bad path", "text/plain")
        body = None
        if self.command == "POST":
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        req = urllib.request.Request(SITE + "/rest/api/3/" + rest, data=body, method=self.command)
        req.add_header("Authorization", AUTH)
        req.add_header("Accept", "application/json")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                self._send(resp.status, resp.read(), resp.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:  # timeout, DNS, connection reset
            self._send(502, json.dumps({"errorMessages": ["Proxy error: %s" % e]}).encode(), "application/json")

    def _send(self, code, data, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("jira-lite on http://localhost:%d  (project %s, Ctrl+C to stop)" % (PORT, PROJECT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
