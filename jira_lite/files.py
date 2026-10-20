"""Attachment downloads the browser can load without the ``X-Jira-Lite`` header.

  GET /files/content/{id}    -> Jira ``attachment/content/{id}``
  GET /files/thumbnail/{id}  -> Jira ``attachment/thumbnail/{id}``

``<img src>`` and ``<a href>`` can't send custom headers, so these GET-only routes are the
one exception to the proxy-header rule. They only map numeric attachment ids (nothing else of
the API is reachable) and only answer requests the browser marks as coming from our own pages:
``Sec-Fetch-Site: same-origin`` (or ``none``: typed or bookmarked), or, for browsers without
Fetch Metadata, an ``Origin``/``Referer`` on one of our allowed origins. Other sites can't
hotlink them or probe which attachments exist.

Jira answers with a 303 to a short-lived Atlassian media URL; the proxy never follows it (that
would send our credentials to another host) and the browser gets the redirect. If an upstream
answers with the bytes directly they are served from our origin, so file responses carry
``nosniff`` and a sandboxing CSP: an uploaded HTML or SVG file can't run script as jira-lite.
"""

import re
import urllib.parse
from typing import Any, Collection, Optional, Tuple

FILE_PREFIX = "/files/"
FILE_RE = re.compile(r"^/files/(content|thumbnail)/(\d{1,20})$")
SAME_ORIGIN_FETCH = ("same-origin", "none")

# Sent with every /files/ response.
FILE_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; "
                                "style-src 'unsafe-inline'"),
    ("Referrer-Policy", "no-referrer"),  # don't leak our URL to the media host on the redirect
    ("Cross-Origin-Resource-Policy", "same-origin"),
)


def proxy_path(path: str) -> Optional[str]:
    """``/files/{kind}/{id}`` -> ``/jira/attachment/{kind}/{id}``, or None if not a file route."""
    m = FILE_RE.match(path)
    if not m:
        return None
    return "/jira/attachment/%s/%s" % (m.group(1), m.group(2))


def _origin_of(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    parts = urllib.parse.urlsplit(url)
    if not parts.scheme or not parts.netloc:
        return None
    return "%s://%s" % (parts.scheme, parts.netloc)


def fetch_allowed(headers: Any, allowed_origins: Collection[str]) -> bool:
    """True if the request comes from one of our own pages (or was typed by the user)."""
    site = headers.get("Sec-Fetch-Site")
    if site:
        return site.strip().lower() in SAME_ORIGIN_FETCH
    origin = headers.get("Origin") or _origin_of(headers.get("Referer"))
    return origin is not None and origin in allowed_origins


def redirect_ok(location: Optional[str]) -> bool:
    """A relayed redirect must be an absolute http(s) URL."""
    if not location:
        return False
    parts = urllib.parse.urlsplit(location)
    return parts.scheme in ("http", "https") and bool(parts.netloc)


def file_headers(status: int, relayed: Tuple[Tuple[str, str], ...]) -> Tuple[Tuple[str, str], ...]:
    """Headers for a /files/ response: Location (redirects) and Content-Disposition from upstream,
    plus FILE_HEADERS."""
    keep = tuple((k, v) for k, v in relayed
                 if k == "Content-Disposition" or (k == "Location" and 300 <= status < 400))
    return keep + FILE_HEADERS
