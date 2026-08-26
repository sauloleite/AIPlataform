"""Heuristicas de injecao de prompt (OWASP LLM01).

Deliberadamente conservadoras. Um detector agressivo bloqueia trabalho legitimo
("me explique como funciona um ataque de prompt injection") e, na pratica, e
desligado pelo time — que e o pior resultado possivel.

Nao substituem os outros controles: conteudo recuperado continua marcado como
dado, argumentos de tool continuam validados por schema e a saida do modelo
continua sem ser executada.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

from guardrails.domain.entities import InjectionSignal

_EXCERPT_LENGTH: Final = 80


@dataclass(frozen=True, slots=True)
class _Rule:
    name: str
    pattern: re.Pattern[str]
    score: float


_RULES: Final[tuple[_Rule, ...]] = (
    _Rule(
        "ignore_previous_instructions",
        re.compile(
            # Duas ordens porque o portugues posterga o adjetivo:
            # "ignore TODAS as INSTRUCOES" e "esqueca as REGRAS ACIMA".
            r"\b(ignor[ae]|esquec[ae]|desconsidere|disregard|forget)\b"
            r"(?:"
            r".{0,40}\b(previous|anterior(es)?|acima|above|all|todas?|todos?)\b"
            r".{0,25}\b(instru(c|ç)(ao|ão|oes|ões)|instructions?|regras?|rules?|prompt)\b"
            r"|"
            r".{0,40}\b(instru(c|ç)(ao|ão|oes|ões)|instructions?|regras?|rules?|prompt)\b"
            r".{0,25}\b(previous|anterior(es)?|acima|above)\b"
            r")",
            re.IGNORECASE | re.DOTALL,
        ),
        0.9,
    ),
    _Rule(
        "reveal_system_prompt",
        re.compile(
            r"\b(revele|mostre|repita|print|reveal|show|repeat)\b.{0,30}"
            r"\b(system\s*prompt|prompt\s*de\s*sistema|suas\s*instru(c|ç)(oes|ões)|your\s*instructions)\b",
            re.IGNORECASE | re.DOTALL,
        ),
        0.85,
    ),
    _Rule(
        "role_override",
        re.compile(
            r"\b(you\s+are\s+now|a\s+partir\s+de\s+agora\s+voc(e|ê)\s+(e|é))\b.{0,40}"
            r"\b(dan|jailbreak|sem\s+restri(c|ç)(oes|ões)|unrestricted|developer\s+mode)\b",
            re.IGNORECASE | re.DOTALL,
        ),
        0.85,
    ),
    _Rule(
        "fake_system_turn",
        # Tenta forjar um turno de sistema dentro do texto do usuario.
        re.compile(r"(^|\n)\s*(<\|?\s*)?(system|assistant)\s*(\|?>|:)\s", re.IGNORECASE),
        0.6,
    ),
    _Rule(
        "exfiltration_via_url",
        re.compile(
            r"\b(envie|mande|poste|send|post|fetch)\b.{0,40}\bhttps?://",
            re.IGNORECASE | re.DOTALL,
        ),
        0.7,
    ),
)


class InjectionHeuristics:
    """Aplica as regras e devolve os sinais encontrados."""

    def analyze(self, text: str) -> tuple[InjectionSignal, ...]:
        signals: list[InjectionSignal] = []
        for rule in _RULES:
            match = rule.pattern.search(text)
            if match is None:
                continue
            signals.append(
                InjectionSignal(
                    rule=rule.name,
                    score=rule.score,
                    # Trecho curto e truncado: o sinal nao pode virar um vazamento.
                    excerpt=match.group(0)[:_EXCERPT_LENGTH],
                )
            )
        return tuple(signals)

    @property
    def rule_names(self) -> tuple[str, ...]:
        return tuple(rule.name for rule in _RULES)
