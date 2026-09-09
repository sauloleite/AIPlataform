"""What the platform refused, as an exception a caller can branch on."""

from __future__ import annotations

from typing import Any

import httpx

from aia_errors import ErrorCode

PROBLEM_CONTENT_TYPE = "application/problem+json"


class PlatformError(Exception):
    """An answer the platform refused to give, with the reason it gave.

    Deliberately NOT a `DomainError`. Those are what a service raises when one
    of its own rules says no, and `is_domain_error` is how the HTTP layer
    decides a message is safe to return to a caller. An answer received from
    somewhere else is not that, however similar it looks, and a client-side type
    claiming to be one would eventually see its message echoed onwards as though
    the local service had produced it.
    """

    def __init__(self, problem: dict[str, Any]) -> None:
        super().__init__(problem.get("detail") or problem.get("title") or "Request failed")
        self.problem = problem
        self.code: str = str(problem.get("code") or ErrorCode.INTERNAL_ERROR)
        self.status: int = int(problem.get("status") or 500)
        #: The platform's own trace id, so a report can be tied to a trace.
        self.trace_id: str | None = problem.get("trace_id")
        #: Present on 429 and 503. Seconds, as the platform sent it.
        retry_after = problem.get("retry_after")
        self.retry_after_seconds: float | None = (
            float(retry_after) if isinstance(retry_after, (int, float)) else None
        )


def error_from(response: httpx.Response, instance: str) -> PlatformError:
    """Reads a failed response as Problem Details, and copes when it is not.

    A proxy in front of the platform answers with its own HTML on a 502, and a
    client that assumed JSON would raise a decode error naming a byte offset
    instead of the status that actually happened. The status is always known;
    everything else is best effort.
    """
    fallback: dict[str, Any] = {
        "type": "about:blank",
        "title": response.reason_phrase or "Request failed",
        "status": response.status_code,
        "detail": f"The platform answered {response.status_code} for {instance}",
        "code": ErrorCode.INTERNAL_ERROR,
        "instance": instance,
    }

    # Parsing IS the check: a body that is not JSON raises here, and a proxy
    # that lies about its content type is exactly the case this has to survive.
    try:
        body = response.json()
    except ValueError:
        return PlatformError(fallback)

    if not isinstance(body, dict) or "status" not in body:
        return PlatformError(fallback)
    return PlatformError({**fallback, **body})
