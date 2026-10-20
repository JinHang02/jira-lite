"""Command-line entry point: ``python3 -m jira_lite``.

Loads settings, binds 127.0.0.1:PORT and serves until Ctrl+C.
"""

import sys
from typing import Optional, Sequence

from .app import create_server
from .config import ConfigError, load_settings


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the server; returns a process exit code."""
    del argv  # no options yet; kept for a conventional signature
    try:
        settings = load_settings()
    except ConfigError as e:
        print("jira-lite: %s" % e, file=sys.stderr)
        return 1
    try:
        server = create_server(settings)
    except OSError as e:
        print("jira-lite: cannot listen on %s:%d (%s)" % (settings.host, settings.port, e),
              file=sys.stderr)
        return 1
    print("jira-lite on http://localhost:%d  (project %s, Ctrl+C to stop)"
          % (server.port, settings.project), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
