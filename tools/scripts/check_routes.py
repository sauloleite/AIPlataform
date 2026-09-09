#!/usr/bin/env python3
"""Compares the routes each service registers against the paths its contract declares.

Why this exists: CI already checks that the contracts parse and that the generated
types match them. Neither noticed that `knowledge.v1.yaml` promised
`DELETE /v1/stores/{storeId}` while no route answered it, or that `GET /v1/registry`
shipped without appearing in any contract. Contract-first is a rule about intent;
this is the rule about what was built.

Routes are read from the decorators rather than from a running application: a booted
Nest module needs Mongo and Redis, and a check that needs the world up is a check
that gets skipped. Every path in this repository is a literal, and the parser
REFUSES a computed one rather than quietly ignoring it -- a route this cannot see
is a route this cannot defend.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
METHODS = ("get", "post", "put", "delete", "patch")

#: Health comes from a shared library in both languages -- `HealthController`
#: in @aia/nest, `health_router()` in aia_fastapi -- so it is declared in every
#: contract and written in no service. A parser that reads only the service's
#: own files has to be told, or it reports every service as missing both.
SHARED_HEALTH = [("get", "/health/live"), ("get", "/health/ready")]


@dataclass(frozen=True, slots=True)
class Service:
    name: str
    runtime: str
    contract: str


SERVICES = (
    Service("identity", "node", "identity.v1.yaml"),
    Service("governance", "node", "governance.v1.yaml"),
    Service("inference-router", "node", "inference-router.v1.yaml"),
    Service("registry", "node", "registry.v1.yaml"),
    Service("knowledge", "node", "knowledge.v1.yaml"),
    Service("mcp-gateway", "node", "mcp-gateway.v1.yaml"),
    Service("guardrails", "python", "guardrails.v1.yaml"),
    Service("agent-runtime", "python", "agent-runtime.v1.yaml"),
    Service("evaluation", "python", "evaluation.v1.yaml"),
)


class ComputedPathError(Exception):
    """A decorator argument that is not a plain string literal."""


_LITERAL = re.compile(r"""^(['"`])([^'"`]*)\1$""")


def literal(argument: str, where: str) -> str:
    text = argument.strip()
    if text == "":
        return ""
    match = _LITERAL.match(text)
    if match is None:
        raise ComputedPathError(
            f"{where}: route path is not a string literal ({text}). This checker "
            f"understands literals only; make the path literal or teach the checker."
        )
    return match.group(2)


def shape(path: str) -> str:
    """A path with every parameter name replaced.

    `:storeId`, `{storeId}` and `{store_id}` route identically, and a contract is
    free to name the parameter in whichever case its language prefers. What has to
    match is the SHAPE.
    """
    normalised = re.sub(r"\{[^}]*\}", "{}", re.sub(r":([A-Za-z_]\w*)", "{}", path))
    normalised = normalised.rstrip("/")
    return normalised or "/"


def key(method: str, path: str) -> str:
    return f"{method.upper()} {shape(path)}"


def join(*parts: str) -> str:
    joined = re.sub(r"/{2,}", "/", "/".join(part for part in parts if part))
    return joined if joined.startswith("/") else f"/{joined}"


_CONTROLLER = re.compile(r"@Controller\(([^)]*)\)")
_NEST_ROUTE = re.compile(rf"@({'|'.join(m.capitalize() for m in METHODS)})\(([^)]*)\)")


def nest_routes(service: str) -> set[tuple[str, str]]:
    routes: set[tuple[str, str]] = set()
    source_root = ROOT / "apps" / service / "src"

    for file in source_root.rglob("*.controller.ts"):
        source = file.read_text()
        where = str(file.relative_to(ROOT))

        controller = _CONTROLLER.search(source)
        if controller is None:
            continue
        prefix = literal(controller.group(1), where)

        for match in _NEST_ROUTE.finditer(source):
            method = match.group(1).lower()
            routes.add((method, join(prefix, literal(match.group(2), where))))

    # HealthController is registered in a module, not written in the service.
    for file in list(source_root.rglob("*.module.ts")) + list(source_root.rglob("*.controller.ts")):
        if "HealthController" in file.read_text():
            routes.update(SHARED_HEALTH)
            break

    return routes


_APIROUTER = re.compile(r"(\w+)\s*=\s*APIRouter\(([^)]*)\)")
_PREFIX = re.compile(r"""prefix\s*=\s*(['"])([^'"]*)\1""")
_FASTAPI_ROUTE = re.compile(rf"@(\w+)\.({'|'.join(METHODS)})\(([^)]*)\)")
#: The import itself, not the mere mention: a comment naming `health_router`
#: must not be enough to convince this that the routes are served.
_FASTAPI_HEALTH = re.compile(r"^from aia_fastapi import [^\n]*\bhealth_router\b", re.MULTILINE)


def fastapi_routes(service: str) -> set[tuple[str, str]]:
    routes: set[tuple[str, str]] = set()

    for file in (ROOT / "apps" / service / "src").rglob("*.py"):
        source = file.read_text()
        if "APIRouter" not in source:
            continue
        where = str(file.relative_to(ROOT))

        prefixes = {
            match.group(1): (prefix.group(2) if (prefix := _PREFIX.search(match.group(2))) else "")
            for match in _APIROUTER.finditer(source)
        }

        if _FASTAPI_HEALTH.search(source) is not None:
            routes.update(SHARED_HEALTH)

        for match in _FASTAPI_ROUTE.finditer(source):
            name, method, arguments = match.groups()
            if name not in prefixes:
                continue
            routes.add((method, join(prefixes[name], literal(arguments.split(",")[0], where))))

    return routes


def contract_routes(contract: str) -> set[tuple[str, str]]:
    document = yaml.safe_load((ROOT / "contracts" / "openapi" / contract).read_text())
    return {
        (method, path)
        for path, operations in (document.get("paths") or {}).items()
        for method in operations
        if method in METHODS
    }


def main() -> int:
    failed = False

    for service in SERVICES:
        registered = (
            nest_routes(service.name) if service.runtime == "node" else fastapi_routes(service.name)
        )
        declared = contract_routes(service.contract)

        if not registered:
            print(
                f"✗ {service.name}: no route found at all. The parser is wrong, not the service.",
                file=sys.stderr,
            )
            failed = True
            continue

        registered_keys = {key(*route) for route in registered}
        declared_keys = {key(*route) for route in declared}

        unimplemented = sorted(declared_keys - registered_keys)
        undeclared = sorted(registered_keys - declared_keys)

        if not unimplemented and not undeclared:
            print(f"✓ {service.name}: {len(registered)} routes match {service.contract}")
            continue

        failed = True
        print(f"✗ {service.name} ({service.contract})", file=sys.stderr)
        for route in unimplemented:
            print(f"    declared, not implemented: {route}", file=sys.stderr)
        for route in undeclared:
            print(f"    implemented, not declared: {route}", file=sys.stderr)

    if failed:
        print(
            "\nA route and its contract disagree. Change the contract first, then the "
            "code: the YAML under contracts/ is the source (CLAUDE.md).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
