"""Safe resolution of static files under the web root.

URL paths are percent-decoded, resolved with ``realpath`` (following
symlinks) and must stay strictly inside the web root; anything else is
treated as not found.
"""

import os
import urllib.parse
from typing import Optional

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
