"""Server assembly: build a ready-to-serve HTTP server from :class:`Settings`."""

import os
from http.server import ThreadingHTTPServer
from typing import Dict, FrozenSet, Optional

from .config import PROJECT_ROOT, Settings
from .handler import Handler
from .proxy import JiraProxy, Opener

DEFAULT_WEB_ROOT = os.path.join(PROJECT_ROOT, "web")


class JiraLiteServer(ThreadingHTTPServer):
    """Threading HTTP server carrying the app state the handler needs."""

    daemon_threads = True

    def __init__(self, settings: Settings, proxy: JiraProxy, web_root: str,
                 quiet: bool = False) -> None:
        self.settings = settings
        self.proxy = proxy
        self.web_root = web_root
        self.quiet = quiet
        super().__init__((settings.host, settings.port), Handler)

    @property
    def port(self) -> int:
        """The actually bound port (differs from settings when port is 0)."""
        return self.server_address[1]

    @property
    def allowed_hosts(self) -> FrozenSet[str]:
        """Host header values accepted by the DNS-rebinding check."""
        return frozenset(("localhost:%d" % self.port, "127.0.0.1:%d" % self.port))

    def public_config(self) -> Dict[str, str]:
        """Non-secret settings exposed to the frontend at ``/config``."""
        s = self.settings
        return {"project": s.project, "site": s.site, "board": s.board}


def create_server(settings: Settings, web_root: Optional[str] = None,
                  opener: Optional[Opener] = None, quiet: bool = False) -> JiraLiteServer:
    """Bind a :class:`JiraLiteServer` (not yet serving) for ``settings``."""
    proxy = JiraProxy(settings.site, settings.auth_header, settings.timeout, opener)
    return JiraLiteServer(settings, proxy, web_root or DEFAULT_WEB_ROOT, quiet=quiet)
