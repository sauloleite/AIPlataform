"""Executa os datasets de red team contra as heuristicas.

Um dataset adversarial que ninguem roda e documentacao, nao defesa. Este teste
faz `evals/redteam/*.jsonl` valer no CI: um ataque conhecido que passar a
escapar, ou um uso legitimo que passar a ser bloqueado, reprova a PR.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from guardrails.application.dto import InspectCommand
from guardrails.application.use_cases.inspect_content import InspectContent
from guardrails.domain.entities import Decision
from guardrails.domain.injection import InjectionHeuristics
from guardrails.infrastructure.regex_detector import RegexPiiDetector

REDTEAM_DIR = Path(__file__).resolve().parents[3] / "evals" / "redteam"


def _load(filename: str) -> list[dict[str, Any]]:
    path = REDTEAM_DIR / filename
    if not path.exists():  # pragma: no cover - protege contra mover o diretorio
        pytest.skip(f"dataset ausente: {path}")
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


@pytest.fixture(scope="module")
def inspect() -> InspectContent:
    return InspectContent(detector=RegexPiiDetector(), heuristics=InjectionHeuristics())


def _ids(cases: list[dict[str, Any]]) -> list[str]:
    return [f"{case['id']}-{case['categoria']}" for case in cases]


ATAQUES = _load("injecao-de-prompt.jsonl")
LEGITIMOS = _load("falso-positivo.jsonl")


@pytest.mark.parametrize(
    "case",
    [c for c in ATAQUES if c["esperado"] == "block"],
    ids=_ids([c for c in ATAQUES if c["esperado"] == "block"]),
)
def test_ataque_conhecido_e_bloqueado(inspect: InspectContent, case: dict[str, Any]) -> None:
    result = inspect.execute(InspectCommand(text=case["input"], project_id="platform-ci"))

    assert result.decision is Decision.BLOCK, (
        f"{case['id']} ({case['referencia']}) deveria ser bloqueado. "
        f"Sinais detectados: {[s.rule for s in result.injection_signals]}"
    )


@pytest.mark.parametrize(
    "case",
    [c for c in ATAQUES if c["esperado"] == "flag"],
    ids=_ids([c for c in ATAQUES if c["esperado"] == "flag"]),
)
def test_sinal_fraco_e_detectado_mas_nao_bloqueia(
    inspect: InspectContent, case: dict[str, Any]
) -> None:
    result = inspect.execute(InspectCommand(text=case["input"], project_id="platform-ci"))

    # Detectar e registrar sem bloquear: o sinal vai para o trace e para o
    # alerta, e o operador decide. Bloquear um padrao que tem leitura legitima
    # (um webhook interno, um log colado) geraria falso positivo.
    assert result.injection_suspected, f"{case['id']} deveria ao menos disparar sinal"
    assert result.decision is not Decision.BLOCK, (
        f"{case['id']} e sinal fraco isolado ({case['nota']}) e nao deveria bloquear"
    )


@pytest.mark.parametrize("case", LEGITIMOS, ids=_ids(LEGITIMOS))
def test_uso_legitimo_nao_e_bloqueado(inspect: InspectContent, case: dict[str, Any]) -> None:
    result = inspect.execute(InspectCommand(text=case["input"], project_id="platform-ci"))

    # Bloquear trabalho legitimo faz o time desligar o guardrail, e um guardrail
    # desligado nao protege nada. Este teste e tao importante quanto o de cima.
    assert result.decision is not Decision.BLOCK, (
        f"{case['id']} e uso legitimo ({case['nota']}) e foi bloqueado por "
        f"{[s.rule for s in result.injection_signals]}"
    )
