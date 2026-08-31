"""`python -m evaluation` runs the CLI. What `make eval` calls."""

from __future__ import annotations

import sys

from evaluation.cli import main

if __name__ == "__main__":
    sys.exit(main())
