"""Forwarding of ``/jira/*`` requests to Jira Cloud.

``/jira/<rest>``  -> ``{site}/rest/api/3/<rest>``

Redirects are never followed: urllib would replay our ``Authorization`` header to
whatever host the ``Location`` names (attachment downloads redirect to Atlassian's media
host). A 3xx is relayed to the browser with its ``Location`` instead.

In OAuth mode :mod:`auth` uses the same sender with a per-user Bearer
header and ``{api}/ex/jira/{cloudId}`` as the site. The query string is preserved. The HTTP layer is injectable (``opener``) so
the mapping and error handling can be tested without a network.
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, NamedTuple, Optional, Tuple

PROXY_PREFIXES = {"/jira/": "/rest/api/3/"}
METHODS_WITH_BODY = ("POST", "PUT")
DEFAULT_CONTENT_TYPE = "application/json"

JSON_ACCEPT = "application/json"
MAX_BODY = 25 * 1024 * 1024  # bytes; larger request bodies are refused with 413
# POST /jira/issue/{key}/attachments carries multipart/form-data, which Jira only accepts with
# its XSRF check disabled; our own CSRF defences (X-Jira-Lite header, Origin) cover it.
ATTACH_UPLOAD_RE = re.compile(r"^/jira/issue/[^/?]+/attachments(?:\?.*)?$")
ATTACH_FILE_RE = re.compile(r"^/jira/attachment/(?:content|thumbnail)/\d+(?:\?.*)?$")
# Upstream response headers relayed to the browser (besides Content-Type).
RELAY_HEADERS = ("Location", "Content-Disposition")

Opener = Callable[..., Any]  # signature of urllib.request.urlopen(req, timeout=...)
Headers = Tuple[Tuple[str, str], ...]


class UnsafePathError(ValueError):
    """The proxied path tries to climb out of the API root (``..``)."""


class ProxyResponse(NamedTuple):
    """Status, body, content type and extra headers (see RELAY_HEADERS) to relay back."""

    status: int
    body: bytes
    content_type: str
    headers: Headers = ()


class Outgoing(NamedTuple):
    """Request headers that depend on the route: Content-Type, Accept, extras."""

    content_type: str
    accept: str
    extra: Headers = ()


def outgoing(method: str, request_path: str, browser_content_type: Optional[str] = None) -> Outgoing:
    """Headers for the upstream request.

    Bodies are JSON, except a multipart/form-data upload to ``issue/{key}/attachments``,
    which keeps the browser's Content-Type (it carries the boundary) and gets
    ``X-Atlassian-Token: no-check``. Attachment downloads accept any type."""
    ctype = (browser_content_type or "").strip()
    if (method == "POST" and ATTACH_UPLOAD_RE.match(request_path)
            and ctype.lower().startswith("multipart/form-data") and "boundary=" in ctype.lower()):
        return Outgoing(ctype, JSON_ACCEPT, (("X-Atlassian-Token", "no-check"),))
    if method == "GET" and ATTACH_FILE_RE.match(request_path):
        return Outgoing(DEFAULT_CONTENT_TYPE, "*/*")
    return Outgoing(DEFAULT_CONTENT_TYPE, JSON_ACCEPT)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Turns every 3xx into an HTTPError instead of following it (with our credentials)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def no_redirect_opener() -> Opener:
    """``urlopen``-compatible callable that never follows redirects."""
    return urllib.request.build_opener(_NoRedirect).open


def match_prefix(path: str) -> Optional[str]:
    """Return the proxy prefix ``path`` starts with, or ``None``."""
    return next((p for p in PROXY_PREFIXES if path.startswith(p)), None)


def upstream_url(site: str, request_path: str) -> Optional[str]:
    """Map a local request path (with query) to the upstream Jira URL.

    Returns ``None`` if the path is not a proxy path. Raises
    :class:`UnsafePathError` if the path part contains ``..`` (literal or
    percent-encoded).
    """
    prefix = match_prefix(request_path)
    if prefix is None:
        return None
    rest = request_path[len(prefix):]
    path_part = rest.split("?", 1)[0]
    if ".." in path_part or ".." in urllib.parse.unquote(path_part):
        raise UnsafePathError(path_part)
    return site.rstrip("/") + PROXY_PREFIXES[prefix] + rest


def error_response(message: str) -> ProxyResponse:
    body = json.dumps({"errorMessages": ["Proxy error: %s" % message]}).encode()
    return ProxyResponse(502, body, DEFAULT_CONTENT_TYPE)


def _content_type(headers: Any) -> str:
    if headers is None:
        return DEFAULT_CONTENT_TYPE
    return headers.get("Content-Type", DEFAULT_CONTENT_TYPE)


def _relayed(headers: Any) -> Headers:
    if headers is None:
        return ()
    return tuple((name, headers.get(name)) for name in RELAY_HEADERS if headers.get(name))


class JiraProxy:
    """Sends requests to Jira (Basic auth unless told otherwise) and relays the answer."""

    def __init__(self, site: str, auth_header: str, timeout: float = 20.0,
                 opener: Optional[Opener] = None) -> None:
        self.site = site.rstrip("/")
        self.auth_header = auth_header
        self.timeout = timeout
        self.opener = opener or no_redirect_opener()

    def build_request(self, method: str, url: str, body: Optional[bytes],
                      auth_header: Optional[str] = None,
                      out: Optional[Outgoing] = None) -> urllib.request.Request:
        """Build the outgoing request with auth/accept/content-type headers."""
        out = out or Outgoing(DEFAULT_CONTENT_TYPE, JSON_ACCEPT)
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", auth_header or self.auth_header)
        req.add_header("Accept", out.accept)
        if body is not None:
            req.add_header("Content-Type", out.content_type)
        for name, value in out.extra:
            req.add_header(name, value)
        return req

    def send(self, method: str, url: str, body: Optional[bytes],
             auth_header: Optional[str] = None, out: Optional[Outgoing] = None) -> ProxyResponse:
        """Perform the request; upstream HTTP errors and redirects pass through unchanged
        (redirects are not followed), any other failure becomes a 502 JSON error."""
        req = self.build_request(method, url, body, auth_header, out)
        try:
            with self.opener(req, timeout=self.timeout) as resp:
                return ProxyResponse(resp.status, resp.read(), _content_type(resp.headers), _relayed(resp.headers))
        except urllib.error.HTTPError as e:
            return ProxyResponse(e.code, e.read(), _content_type(e.headers), _relayed(e.headers))
        except Exception as e:  # timeout, DNS, connection refused/reset
            return error_response(str(e))

    def forward(self, method: str, request_path: str,
                body: Optional[bytes] = None, content_type: Optional[str] = None) -> ProxyResponse:
        """Map ``request_path`` and send. ``content_type`` is the browser's (see
        :func:`outgoing`). Raises :class:`UnsafePathError` or ``LookupError`` (not a proxy path)."""
        url = upstream_url(self.site, request_path)
        if url is None:
            raise LookupError(request_path)
        return self.send(method, url, body, out=outgoing(method, request_path, content_type))
