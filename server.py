#!/usr/bin/env python3
# Compatibility shim: `python3 server.py` runs the jira_lite package (same as `python3 -m jira_lite`).
import sys

from jira_lite.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
