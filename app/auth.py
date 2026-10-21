"""Per-user sign-in ("Sign in with Atlassian") and the Bearer-token Jira proxy.

OAuth-mode routes (wired up in :mod:`handler`):

  GET  /oauth/login     -> 302 to Atlassian; ``state`` is bound to the browser
                           by a short-lived HttpOnly cookie
  GET  /oauth/callback  -> verify state, trade the code for tokens, find the
                           configured Jira site, create a session, 302 to /
  GET  /auth/me         -> who is signed in
  POST /auth/logout     -> forget the session
  /jira/<rest>          -> {api}/ex/jira/{cloudId}/rest/api/3/<rest>, Bearer auth

Access tokens are refreshed shortly before they expire, and once more if
Jira answers 401. Atlassian rotates refresh tokens, so refreshes happen under
a per-session lock: concurrent requests wait for the one refresh in flight
and then use its result instead of spending the old refresh token again.
Nothing here logs or echoes tokens, codes or the client secret.
"""

import hmac
import json
import secrets
import time
import urllib.parse
from typing import NamedTuple, Optional, Tuple

from .config import Settings
from .cookies import expire_cookie, parse_cookies, set_cookie
from .oauth import AtlassianClient, InvalidGrant, OAuthError
from .pages import LOGIN_PATH, error_page
from .proxy import JiraProxy, Outgoing, ProxyResponse, error_response, outgoing, upstream_url
from .sessions import IDLE_TIMEOUT, Clock, Session, SessionStore

SESSION_COOKIE = "jl_session"
STATE_COOKIE = "jl_oauth_state"
STATE_COOKIE_PATH = "/oauth"
STATE_MAX_AGE = 600  # seconds a sign-in attempt may take
REFRESH_MARGIN = 60.0  # refresh access tokens this many seconds before expiry
HTML = "text/html; charset=utf-8"
JSON = "application/json"
TEXT = "text/plain"

Header = Tuple[str, str]


class LoginRequired(Exception):
    """No usable session: the browser has to sign in (again)."""


class Reply(NamedTuple):
    """A complete response for the handler to send."""

    status: int
    body: bytes
    content_type: str
    headers: Tuple[Header, ...] = ()


class OAuthService:
    """Sign-in flow, session lookup and token refresh for OAuth mode."""

    def __init__(self, settings: Settings, client: AtlassianClient, store: SessionStore,
                 proxy: JiraProxy, clock: Clock = time.time) -> None:
        self.site = settings.site.rstrip("/").lower()
        self.secure = settings.scheme == "https"
        self.client = client
        self.store = store
        self.proxy = proxy
        self.clock = clock

    # -- routes -----------------------------------------------------------
    def login(self) -> Reply:
        """Start a sign-in: remember a random ``state`` in a cookie, send the browser to Atlassian."""
        state = secrets.token_urlsafe(32)
        return Reply(302, b"", TEXT, (
            ("Location", self.client.authorize_url(state)),
            ("Set-Cookie", set_cookie(STATE_COOKIE, state, self.secure,
                                      path=STATE_COOKIE_PATH, max_age=STATE_MAX_AGE)),
        ))

    def callback(self, query: str, cookie_header: Optional[str]) -> Reply:
        """Finish a sign-in started by :meth:`login`."""
        params = urllib.parse.parse_qs(query, keep_blank_values=True)

        def param(name: str) -> str:
            return (params.get(name) or [""])[0]

        clear_state = ("Set-Cookie", expire_cookie(STATE_COOKIE, self.secure, path=STATE_COOKIE_PATH))
        error = param("error")
        if error == "access_denied":
            return self._page(403, "Access not granted",
                              "You declined to let jira-lite use your Atlassian account, "
                              "so you are not signed in.", clear_state)
        if error:
            return self._page(400, "Sign-in failed",
                              "Atlassian reported: %s" % (param("error_description") or error), clear_state)
        cookies = parse_cookies(cookie_header)
        expected, state = cookies.get(STATE_COOKIE, ""), param("state")
        if not expected or not state or not hmac.compare_digest(expected.encode(), state.encode()):
            return self._page(400, "Sign-in could not be verified",
                              "This sign-in link is invalid or has expired (sign-ins must finish "
                              "within 10 minutes, in the browser that started them).", clear_state)
        code = param("code")
        if not code:
            return self._page(400, "Sign-in failed", "Atlassian did not send an authorization code.",
                              clear_state)
        try:
            tokens = self.client.exchange_code(code)
            cloud_id = self._cloud_id(tokens.access_token)
            if cloud_id is None:
                return self._page(403, "No access to this Jira site",
                                  "Your account has no access to %s (or it was not selected when "
                                  "granting access). Sign in with an account that can use it."
                                  % self.site, clear_state)
            me = self.client.myself(tokens.access_token, cloud_id)
        except OAuthError as e:
            return self._page(502, "Sign-in failed", str(e), clear_state)
        session = Session(tokens.access_token, tokens.refresh_token, self.clock() + tokens.expires_in,
                          cloud_id, str(me.get("accountId")), str(me.get("displayName") or ""))
        self.store.delete(cookies.get(SESSION_COOKIE))  # replace any earlier session of this browser
        session_id = self.store.create(session)
        return Reply(302, b"", TEXT, (("Location", "/"), clear_state, self._session_cookie(session_id)))

    def me(self, cookie_header: Optional[str]) -> Reply:
        """The signed-in user; raises :class:`LoginRequired`. Slides the cookie expiry."""
        session_id = parse_cookies(cookie_header).get(SESSION_COOKIE)
        session = self.store.get(session_id)
        if session is None or session_id is None:
            raise LoginRequired()
        body = {"accountId": session.account_id, "displayName": session.display_name, "auth": "oauth"}
        return Reply(200, json.dumps(body).encode(), JSON, (self._session_cookie(session_id),))

    def logout(self, cookie_header: Optional[str]) -> Reply:
        """Forget the session server side and expire the cookie."""
        self.store.delete(parse_cookies(cookie_header).get(SESSION_COOKIE))
        return Reply(204, b"", "", (("Set-Cookie", expire_cookie(SESSION_COOKIE, self.secure)),))

    def forward(self, method: str, request_path: str, body: Optional[bytes],
                cookie_header: Optional[str], content_type: Optional[str] = None) -> ProxyResponse:
        """Proxy ``/jira/<rest>`` as the signed-in user (``content_type``: the browser's, see
        :func:`~jira_lite.proxy.outgoing`).

        Raises :class:`~jira_lite.proxy.UnsafePathError`, ``LookupError``
        (not a proxy path) or :class:`LoginRequired`."""
        rel = upstream_url("", request_path)  # "/rest/api/3/<rest>"; validates the path first
        if rel is None:
            raise LookupError(request_path)
        session_id = parse_cookies(cookie_header).get(SESSION_COOKIE)
        session = self.store.get(session_id)
        if session is None or session_id is None:
            raise LoginRequired()
        url = self.client.jira_base(session.cloud_id) + rel
        out = outgoing(method, request_path, content_type)
        try:
            token = self._fresh_token(session_id, session)
            result = self._send(method, url, body, token, out)
            if result.status == 401:  # revoked or clock skew: refresh once and retry
                retry = self._refresh(session_id, session, stale=token)
                if retry != token:
                    result = self._send(method, url, body, retry, out)
        except OAuthError as e:
            return error_response(str(e))
        return result

    # -- tokens -----------------------------------------------------------
    def _fresh_token(self, session_id: str, session: Session) -> str:
        """The access token, refreshed first if it expires within the margin."""
        with session.lock:
            if session.ended:
                raise LoginRequired()
            if session.expires_at - self.clock() > REFRESH_MARGIN:
                return session.access_token
            return self._refresh_locked(session_id, session)

    def _refresh(self, session_id: str, session: Session, stale: str) -> str:
        """Refresh after a 401 for ``stale``, unless another request already did."""
        with session.lock:
            if session.ended:
                raise LoginRequired()
            if session.access_token != stale:
                return session.access_token
            return self._refresh_locked(session_id, session)

    def _refresh_locked(self, session_id: str, session: Session) -> str:
        try:
            tokens = self.client.refresh(session.refresh_token)
        except InvalidGrant:
            session.ended = True
            self.store.delete(session_id)
            raise LoginRequired()
        except OAuthError:
            if session.expires_at > self.clock():
                return session.access_token  # still valid; try refreshing again next time
            raise
        session.access_token = tokens.access_token
        if tokens.refresh_token:  # rotation: the old refresh token is now dead
            session.refresh_token = tokens.refresh_token
        session.expires_at = self.clock() + tokens.expires_in
        return session.access_token

    # -- helpers ----------------------------------------------------------
    def _send(self, method: str, url: str, body: Optional[bytes], token: str,
              out: Optional[Outgoing] = None) -> ProxyResponse:
        return self.proxy.send(method, url, body, auth_header="Bearer " + token, out=out)

    def _cloud_id(self, access_token: str) -> Optional[str]:
        """The cloudId of the configured site among the user's accessible resources."""
        for resource in self.client.accessible_resources(access_token):
            url = str(resource.get("url") or "").rstrip("/").lower()
            if url == self.site and resource.get("id"):
                return str(resource["id"])
        return None

    def _session_cookie(self, session_id: str) -> Header:
        return ("Set-Cookie", set_cookie(SESSION_COOKIE, session_id, self.secure, max_age=int(IDLE_TIMEOUT)))

    @staticmethod
    def _page(status: int, title: str, message: str, *headers: Header) -> Reply:
        return Reply(status, error_page(title, message), HTML, tuple(headers))


LOGIN_REQUIRED_BODY = json.dumps({"error": "login_required", "login": LOGIN_PATH}).encode()
