"""Scoring one production call, after it has already been answered.

Asynchronous by construction: nothing here is on anybody's request path, which
is what makes it affordable to ask a model about a model. The cost is real
though -- one judged evaluator per sampled call -- and that is why the rate is
zero by default.

Everything that can go wrong is recorded as a reason rather than as a score.
A call whose content the project does not keep, a record that has expired, a
judge that answered something unreadable: each of those is a sample that did not
measure anything, and a zero in its place would read as the platform producing
terrible answers.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field

from aia_errors import DomainError
from evaluation.application.ports import (
    CompletionRecordReader,
    Judge,
    SampleRepository,
    ServiceCredential,
)
from evaluation.domain.judging import CRITERIA
from evaluation.domain.sampling import Sample, should_sample

_LOGGER = logging.getLogger(__name__)

#: What an online sample is scored on.
#:
#: Relevance only, and deliberately: groundedness asks whether the answer is
#: supported by the CONTEXT, and a production call's context is whatever the
#: caller put in its prompt -- which the audit stores as one redacted string
#: with no way to tell retrieved passages from instructions. Scoring
#: groundedness against that would grade the answer against the question.
ONLINE_EVALUATORS = ("relevance",)


@dataclass(frozen=True, slots=True)
class UsageEvent:
    """The part of `aia.inference.usage.recorded.v1` a sampler needs."""

    request_id: str
    project_id: str
    alias: str
    status: str

    @classmethod
    def from_event(cls, data: dict[str, object]) -> UsageEvent | None:
        request_id = str(data.get("request_id") or "")
        project_id = str(data.get("project_id") or "")
        if not request_id or not project_id:
            return None
        return cls(
            request_id=request_id,
            project_id=project_id,
            alias=str(data.get("alias") or ""),
            status=str(data.get("status") or ""),
        )


@dataclass(slots=True)
class ScoreSample:
    records: CompletionRecordReader
    judge: Judge
    samples: SampleRepository
    credential: ServiceCredential
    rate: float = 0.0
    evaluators: tuple[str, ...] = field(default=ONLINE_EVALUATORS)

    async def execute(self, event: UsageEvent) -> Sample | None:
        """Scores this call, or None when it was not one of the sampled ones."""
        if not should_sample(event.request_id, rate=self.rate):
            return None

        if event.status != "completed":
            # A call that failed has no answer to grade. It is already counted
            # as an error everywhere else, and scoring it would mix "the model
            # answered badly" into "the platform fell over".
            return None

        sample = await self._score(event)
        await self.samples.save(sample)
        return sample

    async def _score(self, event: UsageEvent) -> Sample:
        token = await self.credential.get()

        try:
            record = await self.records.read(
                project_id=event.project_id, request_id=event.request_id, access_token=token
            )
        except DomainError as error:
            return self._unscorable(event, f"the record could not be read: {error.code}")

        if record is None:
            # Expired under the project's retention, most likely. The sample is
            # kept as a hole rather than dropped: a project whose samples all
            # expire before scoring has a retention shorter than its sampler.
            return self._unscorable(event, "no record: it expired or never existed")

        if not record.get("content_captured"):
            return self._unscorable(event, "this project does not capture content")

        question = str(record.get("prompt") or "")
        answer = str(record.get("completion") or "")
        if not question or not answer:
            return self._unscorable(event, "the record kept no prompt or no answer")

        scores: dict[str, float] = {}
        for evaluator in self.evaluators:
            try:
                scores[evaluator] = await self.judge.score(
                    criterion=CRITERIA[evaluator],
                    question=question,
                    answer=answer,
                    reference="",
                    context=(),
                    project_id=event.project_id,
                    access_token=token,
                )
            except DomainError as error:
                return self._unscorable(event, f"the judge failed: {error.code}")

        return Sample(
            id=str(uuid.uuid4()),
            project_id=event.project_id,
            request_id=event.request_id,
            alias=event.alias,
            scores=scores,
            judge_alias=self.judge.alias,
        )

    def _unscorable(self, event: UsageEvent, reason: str) -> Sample:
        _LOGGER.info("sample %s not scored: %s", event.request_id, reason)
        return Sample(
            id=str(uuid.uuid4()),
            project_id=event.project_id,
            request_id=event.request_id,
            alias=event.alias,
            unscorable=reason,
            judge_alias=self.judge.alias,
        )
