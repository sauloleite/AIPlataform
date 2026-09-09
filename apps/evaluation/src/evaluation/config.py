"""Configuration validated at startup. 12-factor.

The service does not start on invalid configuration. What it CAN start without
is a judge: a suite that needs one then refuses to run rather than scoring
nothing, which is the failure everyone wants and nobody gets.
"""

from __future__ import annotations

from functools import lru_cache

from aia_fastapi import PlatformSettings


class Settings(PlatformSettings):
    port: int = 8003

    inference_router_url: str = "http://inference-router:3000"
    guardrails_url: str = "http://guardrails:8001"

    #: This service's own API, for the CLI. It reads annotations over HTTP with
    #: the caller's token rather than out of the database, so `evaluation
    #: labels` works from a laptop with no database credentials and sees exactly
    #: what that person is allowed to see.
    evaluation_url: str = "http://evaluation:8003"

    mongo_uri: str = "mongodb://mongo:27017"
    mongo_database: str = "aia_evaluation"
    redis_url: str = "redis://redis:6379"

    #: Where the suites live, relative to the repository root.
    suites_path: str = "evals/suites"

    #: Human labels, and the calibration records computed from them (ADR-028).
    labels_path: str = "evals/labels"
    calibrations_path: str = "evals/calibration"

    #: How long a calibration is trusted. An alias is a NAME: a provider
    #: re-points it at a new snapshot and nothing tells the platform. Ninety
    #: days is not a claim about when the model changed -- it is a bound on how
    #: long the platform will keep grading with a number nobody has rechecked.
    #: 0 switches the check off, for a self-hosted model that really is frozen.
    judge_calibration_max_age_days: float = 90.0

    #: The alias that GRADES. Empty disables the judged evaluators, and a suite
    #: that names one then refuses to run.
    #:
    #: It should not be the alias under test: a model asked to grade itself
    #: agrees with itself.
    judge_alias: str = ""

    #: What fraction of completed production calls the sampler scores.
    #:
    #: Zero, and deliberately: sampling spends inference on real traffic and
    #: reads what real people wrote. Turning it on is a decision with a bill and
    #: a privacy consequence, and it should be made rather than inherited.
    online_sample_rate: float = 0.0

    #: The sampler's own identity. It consumes a queue, so there is no caller to
    #: act as (ADR-017 covers the other case) -- and it reads audit content
    #: across projects, which makes this one of the platform's most privileged
    #: credentials. Empty disables the sampler rather than falling back to
    #: anything.
    service_client_id: str = ""
    service_client_secret: str = ""

    #: Which consumer this replica is, in the sampler's consumer group.
    hostname: str = "evaluation-sampler"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
