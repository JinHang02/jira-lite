"""Cookie parsing and ``Set-Cookie`` building.

Every cookie this app sets is ``HttpOnly`` (never readable by page scripts)
and ``SameSite=Lax``; ``Secure`` is added when the server speaks HTTPS.
"""

from typing import Dict, Optional


def parse_cookies(header: Optional[str]) -> Dict[str, str]:
    """Parse a ``Cookie`` request header; malformed pieces are skipped and
    the first occurrence of a name wins."""
    cookies = {}  # type: Dict[str, str]
    for part in (header or "").split(";"):
        name, sep, value = part.strip().partition("=")
        if sep and name and name not in cookies:
            cookies[name] = value.strip().strip('"')
    return cookies


def set_cookie(name: str, value: str, secure: bool, path: str = "/",
               max_age: Optional[int] = None) -> str:
    """A ``Set-Cookie`` value; ``max_age=None`` makes a browser-session cookie."""
    parts = ["%s=%s" % (name, value), "Path=%s" % path]
    if max_age is not None:
        parts.append("Max-Age=%d" % max_age)
    parts += ["HttpOnly", "SameSite=Lax"]
    if secure:
        parts.append("Secure")
    return "; ".join(parts)


def expire_cookie(name: str, secure: bool, path: str = "/") -> str:
    """A ``Set-Cookie`` value that deletes the cookie."""
    return set_cookie(name, "", secure, path=path, max_age=0)
