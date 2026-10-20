"""Configuration: ``.env`` parsing, environment overrides and validation.

Settings come from a ``.env`` file in the project root, overridden by any
``JIRA_*`` or ``ATLASSIAN_*`` variables in the process environment. ``PORT`` is read from the
process environment only. Problems raise :class:`ConfigError`; it is up to
the caller (the CLI) to turn that into a friendly message.

Optional ``JIRA_LITE_*`` keys control how the server is exposed:
``JIRA_LITE_TLS_CERT`` / ``JIRA_LITE_TLS_KEY`` serve HTTPS, and
``JIRA_LITE_PUBLIC_HOSTS`` lists extra host names or IPs (comma separated)
that browsers may use to reach it.

Two auth modes:

* token mode (default): every request uses one person's API token
  (``JIRA_EMAIL`` / ``JIRA_TOKEN``). Binding beyond loopback is refused,
  since exposing it would let anyone on the network act as that person.
* OAuth mode (``ATLASSIAN_CLIENT_ID`` set): each browser signs in with its own
  Atlassian account ("Sign in with Atlassian", OAuth 2.0 3LO). Needs
  ``ATLASSIAN_CLIENT_SECRET`` and ``JIRA_LITE_BASE_URL`` (the public origin;
  the callback is ``<base>/oauth/callback``). Only in this mode, and only
  with TLS, may ``JIRA_LITE_BIND`` name a non-loopback address.
"""

import base64
import os
import urllib.parse
from dataclasses import dataclass
from typing import Dict, List, Mapping, Optional, Tuple

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ENV_FILE = os.path.join(PROJECT_ROOT, ".env")
DEFAULT_PORT = 8765
DEFAULT_PROJECT = "BA"
REQUIRED_KEYS = ("JIRA_SITE", "JIRA_EMAIL", "JIRA_TOKEN")
OAUTH_REQUIRED_KEYS = ("JIRA_SITE", "ATLASSIAN_CLIENT_SECRET", "JIRA_LITE_BASE_URL")
ENV_PREFIXES = ("JIRA_", "ATLASSIAN_")
ATLASSIAN_AUTH_URL = "https://auth.atlassian.com"
ATLASSIAN_API_URL = "https://api.atlassian.com"
OAUTH_CALLBACK_PATH = "/oauth/callback"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


class ConfigError(Exception):
    """Raised when the configuration is missing or invalid."""

    def __init__(self, message: str, missing: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.missing = list(missing or [])


@dataclass(frozen=True)
class Settings:
    """Validated runtime settings."""

    site: str
    email: str = ""  # token mode only
    token: str = ""
    project: str = DEFAULT_PROJECT
    port: int = DEFAULT_PORT
    host: str = "127.0.0.1"
    timeout: float = 20.0  # seconds per upstream Jira request
    tls_cert: str = ""  # PEM certificate chain; set together with tls_key to serve HTTPS
    tls_key: str = ""
    public_hosts: Tuple[str, ...] = ()  # extra Host names/IPs accepted besides localhost
    oauth_client_id: str = ""  # set => OAuth mode (per-user sign-in)
    oauth_client_secret: str = ""
    base_url: str = ""  # public origin, e.g. https://192.168.0.113:8765 (no trailing slash)
    atlassian_auth_url: str = ATLASSIAN_AUTH_URL  # overridable for tests
    atlassian_api_url: str = ATLASSIAN_API_URL

    @property
    def scheme(self) -> str:
        return "https" if self.tls_cert else "http"

    @property
    def oauth(self) -> bool:
        """True when users sign in with Atlassian instead of sharing a token."""
        return bool(self.oauth_client_id)

    @property
    def redirect_uri(self) -> str:
        """OAuth callback URL; must match the app's registered callback exactly."""
        return self.base_url + OAUTH_CALLBACK_PATH

    @property
    def base_host(self) -> str:
        """``host[:port]`` of :attr:`base_url` as browsers send it in ``Host``."""
        return urllib.parse.urlsplit(self.base_url).netloc if self.base_url else ""

    @property
    def auth_header(self) -> str:
        """HTTP Basic ``Authorization`` header value for Jira Cloud."""
        raw = ("%s:%s" % (self.email, self.token)).encode()
        return "Basic " + base64.b64encode(raw).decode()

    def __repr__(self) -> str:  # never leak the token or client secret into logs/tracebacks
        return ("Settings(site=%r, email=%r, token='***', project=%r, port=%r, "
                "oauth_client_id=%r, oauth_client_secret='***', base_url=%r)") % (
            self.site, self.email, self.project, self.port, self.oauth_client_id, self.base_url)


def _unquote(value: str) -> str:
    """Strip one pair of matching surrounding quotes, if present."""
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def parse_env(text: str) -> Dict[str, str]:
    """Parse ``KEY=VALUE`` lines. Blank lines, ``#`` comments and lines
    without ``=`` are ignored; keys and values are trimmed and one pair of
    surrounding quotes is removed from values."""
    env = {}  # type: Dict[str, str]
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = _unquote(value.strip())
    return env


def read_env_file(path: str) -> Dict[str, str]:
    """Read and parse an env file; a missing file yields an empty dict."""
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return parse_env(f.read())


def merge_env(file_env: Mapping[str, str], environ: Mapping[str, str]) -> Dict[str, str]:
    """Overlay ``JIRA_*`` and ``ATLASSIAN_*`` process environment variables on the file values."""
    merged = dict(file_env)
    merged.update({k: v for k, v in environ.items() if k.startswith(ENV_PREFIXES)})
    return merged


def _parse_port(raw: Optional[str]) -> int:
    if raw is None or raw == "":
        return DEFAULT_PORT
    try:
        port = int(raw)
    except ValueError:
        raise ConfigError("PORT must be an integer, got %r." % raw)
    if not 0 <= port <= 65535:
        raise ConfigError("PORT must be between 0 and 65535, got %d." % port)
    return port


def _resolve_path(path: str) -> str:
    """Paths in .env are relative to the project root."""
    return path if not path or os.path.isabs(path) else os.path.join(PROJECT_ROOT, path)


def _tls_paths(env: Mapping[str, str]) -> Tuple[str, str]:
    cert = _resolve_path(env.get("JIRA_LITE_TLS_CERT", ""))
    key = _resolve_path(env.get("JIRA_LITE_TLS_KEY", ""))
    if bool(cert) != bool(key):
        raise ConfigError("Set both JIRA_LITE_TLS_CERT and JIRA_LITE_TLS_KEY, or neither.")
    for path in (cert, key):
        if path and not os.path.isfile(path):
            raise ConfigError("TLS file not found: %s (run `make cert`)." % path)
    return cert, key


def _bind_host(env: Mapping[str, str], oauth: bool, tls: bool) -> str:
    """Loopback always; anything else only with per-user sign-in over HTTPS."""
    host = env.get("JIRA_LITE_BIND", "127.0.0.1") or "127.0.0.1"
    if host in LOOPBACK_HOSTS or (oauth and tls):
        return host
    if oauth:
        raise ConfigError(
            "JIRA_LITE_BIND=%s needs HTTPS: set JIRA_LITE_TLS_CERT and JIRA_LITE_TLS_KEY "
            "(run `make cert`) so sign-in cookies and tokens never cross the network in clear." % host)
    raise ConfigError(
        "JIRA_LITE_BIND=%s would share your Jira API token with everyone on the network. "
        "Set ATLASSIAN_CLIENT_ID (per-user sign-in) and TLS to serve the network." % host)


def _base_url(raw: str, tls: bool) -> str:
    """Validate ``JIRA_LITE_BASE_URL`` (an origin) and normalise it."""
    parts = urllib.parse.urlsplit(raw.strip())
    if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username
            or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment):
        raise ConfigError("JIRA_LITE_BASE_URL must be an origin like https://192.168.0.113:8765, "
                          "got %r." % raw)
    if parts.scheme != ("https" if tls else "http"):
        raise ConfigError("JIRA_LITE_BASE_URL is %s but the server speaks %s; check the TLS settings."
                          % (parts.scheme, "https" if tls else "http"))
    return "%s://%s" % (parts.scheme, parts.netloc.lower())


def settings_from_env(env: Mapping[str, str], port: Optional[str] = None) -> Settings:
    """Validate a merged env mapping and build :class:`Settings`."""
    oauth = bool(env.get("ATLASSIAN_CLIENT_ID"))
    missing = [k for k in (OAUTH_REQUIRED_KEYS if oauth else REQUIRED_KEYS) if not env.get(k)]
    if missing:
        raise ConfigError(
            "Missing %s. Copy .env.example to .env and fill it in." % ", ".join(missing),
            missing=missing,
        )
    cert, key = _tls_paths(env)
    hosts = tuple(h.strip() for h in env.get("JIRA_LITE_PUBLIC_HOSTS", "").split(",") if h.strip())
    return Settings(
        site=env["JIRA_SITE"].rstrip("/"),
        email="" if oauth else env["JIRA_EMAIL"],
        token="" if oauth else env["JIRA_TOKEN"],
        project=env.get("JIRA_PROJECT", DEFAULT_PROJECT),
        port=_parse_port(port),
        host=_bind_host(env, oauth, bool(cert)),
        tls_cert=cert,
        tls_key=key,
        public_hosts=hosts,
        oauth_client_id=env.get("ATLASSIAN_CLIENT_ID", "") if oauth else "",
        oauth_client_secret=env.get("ATLASSIAN_CLIENT_SECRET", "") if oauth else "",
        base_url=_base_url(env["JIRA_LITE_BASE_URL"], bool(cert)) if oauth else "",
    )


def load_settings(env_file: Optional[str] = None,
                  environ: Optional[Mapping[str, str]] = None) -> Settings:
    """Load settings from ``env_file`` (default: ``<project>/.env``) and
    ``environ`` (default: ``os.environ``)."""
    environ = os.environ if environ is None else environ
    file_env = read_env_file(DEFAULT_ENV_FILE if env_file is None else env_file)
    return settings_from_env(merge_env(file_env, environ), port=environ.get("PORT"))
