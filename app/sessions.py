"""In-memory sign-in sessions for OAuth mode.

Sessions live only in this process, so restarting the server signs everyone
out (they click "Sign in with Atlassian" again). Sessions idle for longer
than :data:`IDLE_TIMEOUT` expire; beyond :data:`MAX_SESSIONS` the least
recently used one is evicted. The store is keyed by a SHA-256 of the cookie
value, so the cookie itself is never kept server side.
"""

import hashlib
import secrets
import threading
import time
from collections import OrderedDict
from typing import Callable, Optional

IDLE_TIMEOUT = 30 * 24 * 3600.0  # seconds without use before a session expires
MAX_SESSIONS = 1000

Clock = Callable[[], float]


class Session:
    """One signed-in browser: Atlassian tokens plus who it is.

    ``lock`` serialises token refreshes for this session, so concurrent
    requests never spend the same (rotating) refresh token twice."""

    def __init__(self, access_token: str, refresh_token: str, expires_at: float,
                 cloud_id: str, account_id: str, display_name: str) -> None:
        self.access_token = access_token
        self.refresh_token = refresh_token
        self.expires_at = expires_at  # clock() time when the access token expires
        self.cloud_id = cloud_id
        self.account_id = account_id
        self.display_name = display_name
        self.last_seen = 0.0
        self.ended = False  # set (under ``lock``) once Atlassian refused the refresh token
        self.lock = threading.Lock()

    def __repr__(self) -> str:  # never leak tokens into logs/tracebacks
        return "Session(account_id=%r, display_name=%r, cloud_id=%r)" % (
            self.account_id, self.display_name, self.cloud_id)


def new_session_id() -> str:
    """A fresh, unguessable cookie value."""
    return secrets.token_urlsafe(32)


def _key(session_id: str) -> str:
    return hashlib.sha256(session_id.encode("utf-8", "replace")).hexdigest()


class SessionStore:
    """Thread-safe map of cookie value -> :class:`Session`."""

    def __init__(self, idle_timeout: float = IDLE_TIMEOUT, max_sessions: int = MAX_SESSIONS,
                 clock: Clock = time.time) -> None:
        self.idle_timeout = idle_timeout
        self.max_sessions = max_sessions
        self.clock = clock
        self._lock = threading.Lock()
        self._sessions = OrderedDict()  # type: OrderedDict[str, Session]  # oldest use first

    def __len__(self) -> int:
        with self._lock:
            return len(self._sessions)

    def create(self, session: Session) -> str:
        """Store ``session`` and return its new cookie value."""
        session_id = new_session_id()
        now = self.clock()
        with self._lock:
            self._purge_locked(now)
            while len(self._sessions) >= self.max_sessions:
                self._sessions.popitem(last=False)
            session.last_seen = now
            self._sessions[_key(session_id)] = session
        return session_id

    def get(self, session_id: Optional[str]) -> Optional[Session]:
        """The live session for a cookie value (marking it used), or ``None``."""
        if not session_id:
            return None
        key = _key(session_id)
        now = self.clock()
        with self._lock:
            session = self._sessions.get(key)
            if session is None:
                return None
            if now - session.last_seen > self.idle_timeout:
                del self._sessions[key]
                return None
            session.last_seen = now
            self._sessions.move_to_end(key)
            return session

    def delete(self, session_id: Optional[str]) -> None:
        """Forget a session (sign-out, or its refresh token was refused)."""
        if session_id:
            with self._lock:
                self._sessions.pop(_key(session_id), None)

    def purge(self) -> None:
        """Drop every idle-expired session."""
        with self._lock:
            self._purge_locked(self.clock())

    def _purge_locked(self, now: float) -> None:
        # Ordered by last use, so expired sessions are all at the front.
        while self._sessions:
            key, session = next(iter(self._sessions.items()))
            if now - session.last_seen <= self.idle_timeout:
                break
            del self._sessions[key]
