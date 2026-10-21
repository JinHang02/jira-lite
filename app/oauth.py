"""Atlassian OAuth 2.0 (3LO) client: authorize URL, token grants and the few
API calls needed to set up a session.

Atlassian rotates refresh tokens: every refresh returns a new one and the
old one stops working, so callers must store what :meth:`refresh` returns
and never use a refresh token twice. Error messages raised here are safe to
show to users: they never contain tokens, codes or the client secret.
"""

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

from .proxy import Opener

SCOPES = "read:jira-work write:jira-work read:jira-user offline_access"
AUDIENCE = "api.atlassian.com"


class OAuthError(Exception):
    """Talking to Atlassian failed; the message is safe to display."""


class InvalidGrant(OAuthError):
    """Atlassian rejected the refresh token: the user has to sign in again."""


class Tokens(NamedTuple):
    access_token: str
    refresh_token: str  # "" if Atlassian did not issue one
    expires_in: float  # seconds

    def __repr__(self) -> str:  # never leak tokens into logs/tracebacks
        return "Tokens(access_token='***', refresh_token='***', expires_in=%r)" % self.expires_in


def _error_code(payload: Any) -> str:
    if isinstance(payload, dict):
        return str(payload.get("error") or "")
    return ""


class AtlassianClient:
    """Minimal OAuth/API client for auth.atlassian.com and api.atlassian.com."""

    def __init__(self, client_id: str, client_secret: str, redirect_uri: str,
                 auth_url: str, api_url: str, timeout: float = 20.0,
                 opener: Optional[Opener] = None) -> None:
        self.client_id = client_id
        self._client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.auth_url = auth_url.rstrip("/")
        self.api_url = api_url.rstrip("/")
        self.timeout = timeout
        self.opener = opener or urllib.request.urlopen

    def __repr__(self) -> str:
        return "AtlassianClient(client_id=%r, redirect_uri=%r)" % (self.client_id, self.redirect_uri)

    # -- URLs -------------------------------------------------------------
    def authorize_url(self, state: str) -> str:
        """Where to send the browser to sign in and grant consent."""
        query = urllib.parse.urlencode([
            ("audience", AUDIENCE),
            ("client_id", self.client_id),
            ("scope", SCOPES),
            ("redirect_uri", self.redirect_uri),
            ("state", state),
            ("response_type", "code"),
            ("prompt", "consent"),
        ], quote_via=urllib.parse.quote)
        return "%s/authorize?%s" % (self.auth_url, query)

    def jira_base(self, cloud_id: str) -> str:
        """API root of one Jira site; ``/rest/api/3/...`` is appended to it."""
        return "%s/ex/jira/%s" % (self.api_url, urllib.parse.quote(cloud_id, safe=""))

    # -- token grants -----------------------------------------------------
    def exchange_code(self, code: str) -> Tokens:
        """Trade an authorization code for tokens."""
        status, payload = self._token_request({
            "grant_type": "authorization_code",
            "client_id": self.client_id,
            "client_secret": self._client_secret,
            "code": code,
            "redirect_uri": self.redirect_uri,
        })
        if status != 200:
            raise OAuthError("Atlassian rejected the sign-in (HTTP %d %s)."
                             % (status, _error_code(payload)))
        return self._tokens(payload)

    def refresh(self, refresh_token: str) -> Tokens:
        """Get a new access token (and a NEW refresh token).

        Raises :class:`InvalidGrant` when Atlassian refuses the refresh token
        (any 4xx), :class:`OAuthError` on transient failures."""
        if not refresh_token:
            raise InvalidGrant("No refresh token; sign in again.")
        status, payload = self._token_request({
            "grant_type": "refresh_token",
            "client_id": self.client_id,
            "client_secret": self._client_secret,
            "refresh_token": refresh_token,
        })
        if 400 <= status < 500:
            raise InvalidGrant("Atlassian refused the refresh token (HTTP %d %s)."
                               % (status, _error_code(payload)))
        if status != 200:
            raise OAuthError("Token refresh failed (HTTP %d)." % status)
        return self._tokens(payload)

    # -- API calls --------------------------------------------------------
    def accessible_resources(self, access_token: str) -> List[Dict[str, Any]]:
        """Sites the signed-in user granted this app access to."""
        status, payload = self._request("GET", self.api_url + "/oauth/token/accessible-resources",
                                        bearer=access_token)
        if status != 200 or not isinstance(payload, list):
            raise OAuthError("Could not list your Atlassian sites (HTTP %d)." % status)
        return [r for r in payload if isinstance(r, dict)]

    def myself(self, access_token: str, cloud_id: str) -> Dict[str, Any]:
        """The signed-in user's Jira profile (``accountId``, ``displayName``...)."""
        status, payload = self._request("GET", self.jira_base(cloud_id) + "/rest/api/3/myself",
                                        bearer=access_token)
        if status != 200 or not isinstance(payload, dict) or not payload.get("accountId"):
            raise OAuthError("Could not read your Jira profile (HTTP %d)." % status)
        return payload

    # -- plumbing ---------------------------------------------------------
    def _token_request(self, form: Dict[str, str]) -> Tuple[int, Any]:
        return self._request("POST", self.auth_url + "/oauth/token", body=form)

    @staticmethod
    def _tokens(payload: Any) -> Tokens:
        if not isinstance(payload, dict) or not payload.get("access_token"):
            raise OAuthError("Atlassian sent an unexpected token response.")
        try:
            expires_in = float(payload.get("expires_in") or 3600)
        except (TypeError, ValueError):
            expires_in = 3600.0
        return Tokens(str(payload["access_token"]), str(payload.get("refresh_token") or ""), expires_in)

    def _request(self, method: str, url: str, body: Optional[Dict[str, str]] = None,
                 bearer: Optional[str] = None) -> Tuple[int, Any]:
        """JSON request; returns (status, parsed body or None). HTTP errors are
        returned, network failures raise :class:`OAuthError`."""
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if bearer:
            req.add_header("Authorization", "Bearer " + bearer)
        try:
            with self.opener(req, timeout=self.timeout) as resp:
                status, raw = resp.status, resp.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except Exception as e:  # timeout, DNS, connection refused/reset
            raise OAuthError("Cannot reach Atlassian (%s)." % type(e).__name__)
        try:
            return status, json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            return status, None
