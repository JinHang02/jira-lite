"""Safe resolution of static files under the web root.

URL paths are percent-decoded, resolved with ``realpath`` (following
symlinks) and must stay strictly inside the web root; anything else is
treated as not found.
"""

import hashlib
import os
import re
import time
import urllib.parse
from typing import Optional, Tuple

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".png": "image/png",
}
DEFAULT_CONTENT_TYPE = "application/octet-stream"
INDEX_FILE = "index.html"


def content_type(path: str) -> str:
    """Content type for a file path, based on its extension."""
    return CONTENT_TYPES.get(os.path.splitext(path)[1].lower(), DEFAULT_CONTENT_TYPE)


def resolve(web_root: str, url_path: str) -> Optional[str]:
    """Return the absolute file path for ``url_path`` (no query string), or
    ``None`` if it does not name a regular file inside ``web_root``."""
    root = os.path.realpath(web_root)
    decoded = urllib.parse.unquote(url_path)
    if "\x00" in decoded:
        return None
    rel = INDEX_FILE if decoded == "/" else decoded.lstrip("/")
    full = os.path.realpath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None
    return full


def read(path: str) -> bytes:
    """Read a resolved static file."""
    with open(path, "rb") as f:
        return f.read()


def etag(path: str) -> str:
    """A validator for a static file: its modification time and size."""
    st = os.stat(path)
    return '"%x-%x"' % (st.st_mtime_ns, st.st_size)


def etag_matches(if_none_match: Optional[str], tag: str) -> bool:
    """True if an If-None-Match header names ``tag`` (weak tags count) or is ``*``."""
    if not if_none_match:
        return False
    tags = [t.strip() for t in if_none_match.split(",")]
    return "*" in tags or tag in tags or ("W/" + tag) in tags


# ---- versioned URLs: reloads need no requests for unchanged files ----
#
# The page and every module are served with "?v=<version>" added to their js/css references, where
# the version hashes every file under the web root (path, mtime, size). A request carrying the
# current version may be cached for good (IMMUTABLE); any edit changes the version and so every URL.
# No build step: the rewrite happens as the files are served.

IMMUTABLE = "public, max-age=31536000, immutable"
_IMPORT = re.compile(r"""(\b(?:from|import)\s*\(?\s*)(["'])(\.{1,2}/[^"'?#]+\.js)\2""")
_ASSET = re.compile(r"""\b(href|src)="((?:js|css)/[^"?#]+\.(?:js|css))\"""")
_VERSION_TTL = 1.0  # seconds a computed version is reused (a page load asks ~60 times)
_version = (0.0, "", "")  # type: Tuple[float, str, str]


def app_version(web_root: str) -> str:
    """Short hash of every file's path, modification time and size under ``web_root``."""
    global _version
    now = time.monotonic()
    at, root, ver = _version
    if root == web_root and now - at < _VERSION_TTL:
        return ver
    h = hashlib.sha1()
    for dirpath, dirs, names in os.walk(web_root):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(dirpath, name)
            st = os.stat(full)
            h.update(("%s:%x:%x;" % (os.path.relpath(full, web_root), st.st_mtime_ns, st.st_size)).encode())
    ver = h.hexdigest()[:12]
    _version = (now, web_root, ver)
    return ver


def versioned(path: str, body: bytes, version: str) -> bytes:
    """``body`` with ``?v=version`` on relative module imports (.js) or js/css links (.html)."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".js":
        text = _IMPORT.sub(lambda m: m.group(1) + m.group(2) + m.group(3) + "?v=" + version + m.group(2), body.decode("utf-8"))
    elif ext == ".html":
        text = _ASSET.sub(lambda m: '%s="%s?v=%s"' % (m.group(1), m.group(2), version), body.decode("utf-8"))
    else:
        return body
    return text.encode("utf-8")
