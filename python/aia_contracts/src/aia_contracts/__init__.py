"""What the contracts say, in Python.

Generated from `contracts/openapi/` by `make contracts`, and diff-checked in CI:
nothing here is edited by hand, and nothing here disagrees with the TypeScript
that comes out of the same source.

Today that is the data-zone rule. It is here rather than in `aia_auth` because
it is a fact about the contract, and because it had been written out four times
-- in `packages/auth`, in `python/aia_auth`, in aia-governance's domain and in
the console's -- which is four chances for the rule that decides whether
restricted data may leave the machine to disagree with itself (ADR-027).
"""

from aia_contracts._generated.data_zones import (
    CLASSIFICATIONS,
    DATA_ZONES,
    MAX_ZONES_BY_CLASSIFICATION,
)

__all__ = [
    "CLASSIFICATIONS",
    "DATA_ZONES",
    "MAX_ZONES_BY_CLASSIFICATION",
]
