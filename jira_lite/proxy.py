"""Forwarding of ``/jira/*`` requests to Jira Cloud.

``/jira/<rest>``  -> ``{site}/rest/api/3/<rest>``

The query string is preserved. The HTTP layer is injectable (``opener``) so
the mapping and error handling can be tested without a network.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, NamedTuple, Optional

PROXY_PREFIXES = {"/jira/": "/rest/api/3/"}
METHODS_WITH_BODY = ("POST", "PUT")
DEFAULT_CONTENT_TYPE = "application/json"

Opener = Callable[..., Any]  # signature of urllib.request.urlopen(req, timeout=...)


class UnsafePathError(ValueError):
    """The proxied path tries to climb out of the API root (``..``)."""


class ProxyResponse(NamedTuple):
    """Status, body and content type to relay back to the browser."""

    status: int
    body: bytes
    content_type: str


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


def _error_response(message: str) -> ProxyResponse:
    body = json.dumps({"errorMessages": ["Proxy error: %s" % message]}).encode()
    return ProxyResponse(502, body, DEFAULT_CONTENT_TYPE)


def _content_type(headers: Any) -> str:
    if headers is None:
        return DEFAULT_CONTENT_TYPE
    return headers.get("Content-Type", DEFAULT_CONTENT_TYPE)


class JiraProxy:
    """Sends requests to Jira with Basic auth and relays the answer."""

    def __init__(self, site: str, auth_header: str, timeout: float = 20.0,
                 opener: Optional[Opener] = None) -> None:
        self.site = site.rstrip("/")
        self.auth_header = auth_header
        self.timeout = timeout
        self.opener = opener or urllib.request.urlopen

    def build_request(self, method: str, url: str,
                      body: Optional[bytes]) -> urllib.request.Request:
        """Build the outgoing request with auth/accept/content-type headers."""
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", self.auth_header)
        req.add_header("Accept", "application/json")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        return req

    def send(self, method: str, url: str, body: Optional[bytes]) -> ProxyResponse:
        """Perform the request; upstream HTTP errors pass through unchanged,
        any other failure becomes a 502 JSON error."""
        req = self.build_request(method, url, body)
        try:
            with self.opener(req, timeout=self.timeout) as resp:
                return ProxyResponse(resp.status, resp.read(), _content_type(resp.headers))
        except urllib.error.HTTPError as e:
            return ProxyResponse(e.code, e.read(), _content_type(e.headers))
        except Exception as e:  # timeout, DNS, connection refused/reset
            return _error_response(str(e))

    def forward(self, method: str, request_path: str,
                body: Optional[bytes] = None) -> ProxyResponse:
        """Map ``request_path`` and send. Raises :class:`UnsafePathError`
        or ``LookupError`` (not a proxy path)."""
        url = upstream_url(self.site, request_path)
        if url is None:
            raise LookupError(request_path)
        return self.send(method, url, body)
