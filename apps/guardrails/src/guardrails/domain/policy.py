"""Decision and redaction strategy. Pure rule."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from enum import StrEnum
from typing import Final

from guardrails.domain.entities import Decision, Finding, InjectionSignal

BLOCK_THRESHOLD: Final = 0.8
#: Distinct weak signals that, taken together, are enough to block.
MIN_SIGNALS_TO_BLOCK: Final = 2


class RedactionStrategy(StrEnum):
    REPLACE = "replace"
    MASK = "mask"
    HASH = "hash"


def decide(
    findings: Sequence[Finding],
    signals: Sequence[InjectionSignal],
    *,
    block_threshold: float = BLOCK_THRESHOLD,
) -> Decision:
    """Blocks only on strong injection; PII is a case for redacting, not refusing.

    Refusing a request because it contains a national ID would punish the user
    for data the platform knows how to handle. Strong injection is different:
    there is no safe version of the content to carry forward.

    Two criteria lead to a block, and the second exists for a practical reason:

    1. A STRONG signal on its own (score above the threshold). "Ignore the
       previous instructions" has no innocent reading.
    2. TWO OR MORE distinct signals, even weak ones. In isolation, "send it to
       https://..." may be a legitimate internal webhook, and a `system:` turn
       in the text may be someone pasting a log. The two together, in the same
       message, stop being a coincidence.

    The combination criterion is what lets the weak signals keep a low score --
    blocking on each one alone would produce false positives, and a guardrail
    that gets in the way ends up switched off.
    """
    if signals:
        strongest = max(signal.score for signal in signals)
        distinct_rules = {signal.rule for signal in signals}
        if strongest >= block_threshold or len(distinct_rules) >= MIN_SIGNALS_TO_BLOCK:
            return Decision.BLOCK

    if findings:
        return Decision.REDACT
    return Decision.ALLOW


def apply_redaction(
    text: str, findings: Sequence[Finding], strategy: RedactionStrategy
) -> tuple[str, int]:
    """Replaces the occurrences and returns the new text plus how many changed.

    Applies back to front: replacing from the start would invalidate the offsets
    of every following occurrence.
    """
    ordered = sorted(findings, key=lambda finding: finding.start, reverse=True)

    # Drops overlaps: keeping both would corrupt the text.
    kept: list[Finding] = []
    for finding in ordered:
        if any(finding.overlaps(existing) for existing in kept):
            continue
        kept.append(finding)

    redacted = text
    for finding in kept:
        original = text[finding.start : finding.end]
        redacted = (
            redacted[: finding.start]
            + _replacement(original, finding.entity_type, strategy)
            + redacted[finding.end :]
        )
    return redacted, len(kept)


def _mask_keeping_last(original: str, *, visible: int) -> str:
    """Masks everything but the last `visible` alphanumeric characters.

    It counts ALPHANUMERIC characters, not positions: masking by position in
    `111.444.777-35` would leave a hyphen visible where a digit should be. The
    separators are preserved, which keeps the value recognisable to its owner
    without revealing the data.
    """
    kept = 0
    masked: list[str] = []
    for char in reversed(original):
        if not char.isalnum():
            masked.append(char)
            continue
        if kept < visible:
            masked.append(char)
            kept += 1
        else:
            masked.append("*")
    return "".join(reversed(masked))


def _replacement(original: str, entity_type: str, strategy: RedactionStrategy) -> str:
    if strategy is RedactionStrategy.MASK:
        return _mask_keeping_last(original, visible=4)
    if strategy is RedactionStrategy.HASH:
        # Lets occurrences of the same value be correlated without revealing it.
        digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:12]
        return f"<{entity_type}:{digest}>"
    return f"<{entity_type}>"
