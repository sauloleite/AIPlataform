"""AUTOMATICALLY GENERATED. Do not edit.

Source: contracts/openapi/_shared.yaml. Regenerate with `make contracts`.
"""

from typing import Final

DATA_ZONES: Final[tuple[str, ...]] = ("local", "br", "us", "eu", "global",)

CLASSIFICATIONS: Final[tuple[str, ...]] = ("public", "internal", "confidential", "restricted",)

#: ADR-010: the most a classification may reach. A policy narrows, never widens.
MAX_ZONES_BY_CLASSIFICATION: Final[dict[str, tuple[str, ...]]] = {
    "public": ("local", "br", "us", "eu", "global",),
    "internal": ("local", "br", "us", "eu", "global",),
    "confidential": ("local", "br",),
    "restricted": ("local",),
}
