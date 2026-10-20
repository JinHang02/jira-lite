"""Tiny server-rendered HTML pages (sign-in errors). All text is escaped."""

import html

LOGIN_PATH = "/oauth/login"

_TEMPLATE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jira-lite: %(title)s</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#172b4d}
h1{font-size:1.25rem}a{color:#0c66e4}
</style></head>
<body><h1>%(title)s</h1><p>%(message)s</p>
<p><a href="%(login)s">Try again</a> &middot; <a href="/">Back to jira-lite</a></p>
</body></html>
"""


def error_page(title: str, message: str) -> bytes:
    """A sign-in error page with a "Try again" link to the login route."""
    return (_TEMPLATE % {
        "title": html.escape(title),
        "message": html.escape(message),
        "login": LOGIN_PATH,
    }).encode("utf-8")
