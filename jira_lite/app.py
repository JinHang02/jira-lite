"""Server assembly: build a ready-to-serve HTTP server from :class:`Settings`."""

import os
import socket
import ssl
import sys
from http.server import ThreadingHTTPServer
from typing import Dict, FrozenSet, Optional

from .auth import OAuthService
from .config import PROJECT_ROOT, Settings
from .handler import Handler
from .oauth import AtlassianClient
from .proxy import JiraProxy, Opener
from .sessions import SessionStore

DEFAULT_WEB_ROOT = os.path.join(PROJECT_ROOT, "web")


class JiraLiteServer(ThreadingHTTPServer):
    """Threading HTTP server carrying the app state the handler needs."""

    daemon_threads = True

    def __init__(self, settings: Settings, proxy: JiraProxy, web_root: str,
                 quiet: bool = False, auth: Optional[OAuthService] = None) -> None:
        self.settings = settings
        self.proxy = proxy  # token mode (shared Basic auth)
        self.auth = auth  # OAuth mode (per-user sessions); None in token mode
        self.web_root = web_root
        self.quiet = quiet
        super().__init__((settings.host, settings.port), Handler)
        if settings.tls_cert:
            self.socket = tls_context(settings).wrap_socket(
                self.socket, server_side=True,
                # Handshake lazily in the worker thread, so one slow client can't stall accept().
                do_handshake_on_connect=False)

    @property
    def port(self) -> int:
        """The actually bound port (differs from settings when port is 0)."""
        return self.server_address[1]

    @property
    def allowed_hosts(self) -> FrozenSet[str]:
        """Host header values accepted by the DNS-rebinding check."""
        names = ("localhost", "127.0.0.1") + self.settings.public_hosts
        hosts = {"%s:%d" % (name, self.port) for name in names}
        if self.settings.base_host:
            hosts.add(self.settings.base_host)
        return frozenset(hosts)

    @property
    def allowed_origins(self) -> FrozenSet[str]:
        """``Origin`` header values accepted on POST/PUT (scheme://host:port)."""
        origins = {"%s://%s" % (self.settings.scheme, host) for host in self.allowed_hosts}
        if self.settings.base_url:
            origins.add(self.settings.base_url)
        return frozenset(origins)

    def handle_error(self, request, client_address) -> None:
        # Browsers drop the connection when they reject a self-signed cert; that's not a server bug.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ssl.SSLError, ConnectionError, socket.timeout)):
            return
        super().handle_error(request, client_address)

    def public_config(self) -> Dict[str, str]:
        """Non-secret settings exposed to the frontend at ``/config``."""
        s = self.settings
        return {"project": s.project, "site": s.site, "auth": "oauth" if s.oauth else "token"}


def tls_context(settings: Settings) -> ssl.SSLContext:
    """Server-side TLS context (TLS 1.2+) for the configured certificate."""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(settings.tls_cert, settings.tls_key)
    return ctx


def create_server(settings: Settings, web_root: Optional[str] = None,
                  opener: Optional[Opener] = None, quiet: bool = False) -> JiraLiteServer:
    """Bind a :class:`JiraLiteServer` (not yet serving) for ``settings``."""
    proxy = JiraProxy(settings.site, settings.auth_header, settings.timeout, opener)
    auth = oauth_service(settings, opener) if settings.oauth else None
    return JiraLiteServer(settings, proxy, web_root or DEFAULT_WEB_ROOT, quiet=quiet, auth=auth)


def oauth_service(settings: Settings, opener: Optional[Opener] = None) -> OAuthService:
    """Wire up per-user sign-in for OAuth mode (fresh, empty session store)."""
    client = AtlassianClient(settings.oauth_client_id, settings.oauth_client_secret,
                             settings.redirect_uri, settings.atlassian_auth_url,
                             settings.atlassian_api_url, settings.timeout, opener)
    proxy = JiraProxy(settings.atlassian_api_url, "", settings.timeout, opener)
    return OAuthService(settings, client, SessionStore(), proxy)
