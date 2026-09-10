"""The online sampler: a worker, not a route.

It consumes `aia.inference.usage.recorded.v1`, keeps a deterministic fraction of
the calls, reads what each one said, and asks the judge how it did. Nothing here
is on a request path.

**It does not start unless three things are true**, and each refusal names
itself, because a sampler that runs and scores nothing is worse than one that
does not run: the summaries look thin rather than absent, and nobody goes
looking.

  a rate above zero      -- sampling spends inference on production traffic
  a judge alias          -- there is nothing to score with
  a service credential   -- it reads other people's conversations, and it does
                            that as itself, so it needs its own identity

The third is the one to think hardest about. This worker reads content across
every project it samples, which makes it one of the most privileged components
in the platform. It is why the credential is a client_credentials principal
rather than a shared token, why the rate is zero by default, and why the ADR
says a deployment should give it the narrowest identity that can still read an
audit record.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import redis.asyncio as redis

from aia_auth import ServiceTokenProvider
from aia_messaging import CloudEvent, EventType, RedisStreamSubscriber
from evaluation.application.use_cases.score_sample import ScoreSample, UsageEvent
from evaluation.config import get_settings
from evaluation.domain.calibration import refusal
from evaluation.infrastructure.files import JsonCalibrationStore
from evaluation.infrastructure.mongo import MongoSampleRepository, mongo_client
from evaluation.infrastructure.platform_clients import ModelJudge, RouterRecordClient

_LOGGER = logging.getLogger(__name__)

GROUP = "aia-evaluation-sampler"


def _refusals() -> list[str]:
    """Why this worker will not start, if it will not."""
    configured = get_settings()
    reasons = []
    if configured.online_sample_rate <= 0.0:
        reasons.append("ONLINE_SAMPLE_RATE is 0: nothing is sampled")
    if not configured.judge_alias:
        reasons.append("JUDGE_ALIAS is empty: there is nothing to score with")
    if not configured.service_client_id or not configured.service_client_secret:
        reasons.append(
            "no service credential (SERVICE_CLIENT_ID, SERVICE_CLIENT_SECRET): the sampler reads "
            "production content and does it as itself"
        )
    return reasons


def _uncalibrated(evaluators: tuple[str, ...]) -> list[str]:
    """The same bar a judged suite clears (ADR-028), applied before consuming.

    An online sample is a judged score that reaches a dashboard instead of a
    gate, which makes an unchecked judge here harder to notice rather than less
    dangerous.
    """
    settings = get_settings()
    store = JsonCalibrationStore(settings.calibrations_path)
    reasons = []
    for evaluator in evaluators:
        reason = refusal(
            store.find(judge_alias=settings.judge_alias, evaluator=evaluator),
            judge_alias=settings.judge_alias,
            evaluator=evaluator,
            max_age_days=settings.judge_calibration_max_age_days,
            now=datetime.now(UTC),
        )
        if reason is not None:
            reasons.append(reason)
    return reasons


async def run() -> int:
    logging.basicConfig(level=get_settings().log_level.upper())
    settings = get_settings()

    blocked = _refusals()
    if blocked:
        for reason in blocked:
            _LOGGER.warning("online sampling is off: %s", reason)
        return 0

    use_case = ScoreSample(
        records=RouterRecordClient(base_url=settings.inference_router_url),
        judge=ModelJudge(base_url=settings.inference_router_url, alias=settings.judge_alias),
        samples=MongoSampleRepository(mongo_client(settings.mongo_uri)[settings.mongo_database]),
        credential=ServiceTokenProvider(
            identity_url=settings.identity_issuer,
            client_id=settings.service_client_id,
            client_secret=settings.service_client_secret,
        ),
        rate=settings.online_sample_rate,
    )

    uncalibrated = _uncalibrated(use_case.evaluators)
    if uncalibrated:
        for reason in uncalibrated:
            _LOGGER.error("online sampling refuses to run: %s", reason)
        return 2

    subscriber = RedisStreamSubscriber(
        redis=redis.from_url(settings.redis_url, decode_responses=True),
        group=GROUP,
        consumer=settings.hostname,
    )

    async def handle(event: CloudEvent) -> None:
        usage = UsageEvent.from_event(event.data)
        if usage is None:
            # An event without a request id or a project cannot be sampled and
            # will never become sampleable. Acknowledged by returning rather
            # than retried until it dead-letters.
            _LOGGER.warning("usage event %s carries no request id", event.id)
            return
        await use_case.execute(usage)

    await subscriber.subscribe(EventType.USAGE_RECORDED, handle)
    _LOGGER.info(
        "online sampling %.2f%% of completed calls, graded by %s",
        settings.online_sample_rate * 100,
        settings.judge_alias,
    )
    await subscriber.start()
    return 0


def main() -> int:
    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
