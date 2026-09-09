"""Dependency composition. Never inside a use case."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import redis.asyncio as redis

from aia_auth import JwtVerifier
from aia_messaging import RedisStreamPublisher
from evaluation.application.ports import Judge, RunRepository, SafetyInspector
from evaluation.application.use_cases.annotate import ListAnnotations, RecordAnnotation
from evaluation.application.use_cases.run_suite import RunSuite
from evaluation.config import Settings, get_settings
from evaluation.infrastructure.files import (
    JsonCalibrationStore,
    JsonlDatasetSource,
    YamlSuiteSource,
)
from evaluation.infrastructure.mongo import (
    MongoAnnotationRepository,
    MongoRunRepository,
    ensure_indexes,
    mongo_client,
)
from evaluation.infrastructure.platform_clients import (
    GuardrailsSafetyInspector,
    ModelJudge,
    RouterTargetClient,
)


@dataclass(slots=True)
class Container:
    settings: Settings
    run_suite: RunSuite
    record_annotation: RecordAnnotation
    list_annotations: ListAnnotations
    runs: RunRepository
    verifier: JwtVerifier
    _database: Any

    async def start(self) -> None:
        await ensure_indexes(self._database)

    async def ready(self) -> bool:
        await self._database.command("ping")
        return True


@lru_cache(maxsize=1)
def get_container() -> Container:
    settings = get_settings()
    database = mongo_client(settings.mongo_uri)[settings.mongo_database]
    runs = MongoRunRepository(database)
    annotations = MongoAnnotationRepository(database)

    # No judge alias configured means no judge. A suite that needs one refuses
    # to run, rather than reporting a pass nobody measured.
    judge: Judge | None = (
        ModelJudge(base_url=settings.inference_router_url, alias=settings.judge_alias)
        if settings.judge_alias
        else None
    )
    safety: SafetyInspector | None = (
        GuardrailsSafetyInspector(base_url=settings.guardrails_url)
        if settings.guardrails_url
        else None
    )

    return Container(
        settings=settings,
        runs=runs,
        record_annotation=RecordAnnotation(annotations=annotations),
        list_annotations=ListAnnotations(annotations=annotations),
        _database=database,
        run_suite=RunSuite(
            suites=YamlSuiteSource(),
            datasets=JsonlDatasetSource(),
            target=RouterTargetClient(base_url=settings.inference_router_url),
            runs=runs,
            events=RedisStreamPublisher(redis=redis.from_url(settings.redis_url)),
            judge=judge,
            safety=safety,
            calibrations=JsonCalibrationStore(settings.calibrations_path),
            max_calibration_age_days=settings.judge_calibration_max_age_days,
        ),
        verifier=JwtVerifier(
            issuer=settings.identity_issuer,
            jwks_uri=settings.jwks_url,
            audience=settings.identity_audience,
        ),
    )
