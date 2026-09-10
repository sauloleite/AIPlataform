#!/usr/bin/env python3
"""Every path routed at the compose edge is routed by the chart, and the reverse.

The failure this exists for has happened twice. `/v1/runs` reached the console
instead of the agent runtime, which is why ADR-024 was written; then
`/v1/annotations`, `/v1/samples` and `/v1/completions` were added to compose and
not to the chart, so the same class of drift came back inside the change that
claimed to have fixed it.

Nothing else compares the two: `check_routes.py` reconciles a service's
decorators against its contract, and the Helm coverage check counts Deployments.
A path can therefore exist, be declared, be reachable in development and 404 in
production, which is the worst place to find out.

Reads the rendered chart on stdin:

    helm template aia deploy/helm/aia-platform | python3 tools/scripts/check-edge-routes.py
"""

from __future__ import annotations

import pathlib
import re
import sys

import yaml

COMPOSE = pathlib.Path("deploy/compose/docker-compose.yml")

#: Traefik's rule for "everything else". The chart appends it last rather than
#: listing it, so comparing it would report a difference that is not one.
CATCH_ALL = "/"

_PREFIX = re.compile(r"PathPrefix\(`([^`]+)`\)")


class _Loader(yaml.SafeLoader):
    pass


# Compose's own `!override` tag, which PyYAML has never heard of.
_Loader.add_multi_constructor("!", lambda _loader, _suffix, _node: None)


def compose_prefixes() -> set[str]:
    # The suppression below is not a shortcut: `_Loader` IS a SafeLoader,
    # extended only to read compose's `!override` tag as whatever it wraps.
    # Ruff sees `yaml.load` with a custom loader and cannot see the base class.
    compose = yaml.load(COMPOSE.read_text(encoding="utf-8"), Loader=_Loader)  # noqa: S506
    found: set[str] = set()
    for service in compose["services"].values():
        labels = service.get("labels") or {}
        if not isinstance(labels, dict):
            continue
        for key, value in labels.items():
            if key.endswith(".rule") and isinstance(value, str):
                found.update(_PREFIX.findall(value))
    return found - {CATCH_ALL}


def chart_prefixes(rendered: str) -> set[str]:
    found: set[str] = set()
    for document in yaml.safe_load_all(rendered):
        if not isinstance(document, dict):
            continue
        if document.get("kind") == "HTTPRoute":
            for rule in document["spec"].get("rules") or []:
                for match in rule.get("matches") or []:
                    value = (match.get("path") or {}).get("value")
                    if value:
                        found.add(value)
        elif document.get("kind") == "Ingress":
            for rule in document["spec"].get("rules") or []:
                for path in ((rule.get("http") or {}).get("paths")) or []:
                    if path.get("path"):
                        found.add(path["path"])
    return found - {CATCH_ALL}


def main() -> int:
    rendered = sys.stdin.read()
    if not rendered.strip():
        print("::error::nothing was rendered; pipe `helm template` into this")
        return 1

    at_the_edge = compose_prefixes()
    in_the_chart = chart_prefixes(rendered)

    failed = False
    for missing in sorted(at_the_edge - in_the_chart):
        print(f"::error::{missing} is routed in compose and by no chart route: it would 404")
        failed = True
    for extra in sorted(in_the_chart - at_the_edge):
        print(f"::error::{extra} is routed by the chart and not in compose: one of them is wrong")
        failed = True

    if not failed:
        print(f"the edge routes {len(at_the_edge)} prefixes, and the chart routes the same ones")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
