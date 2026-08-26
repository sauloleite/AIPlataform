"""Decisao e estrategia de redacao. Regra pura."""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from enum import StrEnum
from typing import Final

from guardrails.domain.entities import Decision, Finding, InjectionSignal

BLOCK_THRESHOLD: Final = 0.8
#: Sinais fracos distintos que, somados, bastam para bloquear.
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
    """Bloqueia so por injecao forte; PII e caso de redigir, nao de recusar.

    Recusar a requisicao por conter um CPF puniria o usuario por um dado que a
    plataforma sabe tratar. Injecao forte e diferente: nao ha versao segura do
    conteudo para seguir adiante.

    Dois criterios levam a bloqueio, e o segundo existe por uma razao pratica:

    1. Um sinal FORTE sozinho (score acima do limiar). "Ignore as instrucoes
       anteriores" nao tem leitura inocente.
    2. DOIS OU MAIS sinais distintos, ainda que fracos. Isolado, "envie para
       https://..." pode ser um webhook interno legitimo, e um turno `system:`
       no texto pode ser alguem colando um log. Os dois juntos, na mesma
       mensagem, deixam de ser coincidencia.

    O criterio de combinacao e o que permite manter os sinais fracos com score
    baixo — bloquear cada um deles isoladamente geraria falso positivo, e um
    guardrail que atrapalha acaba desligado.
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
    """Substitui as ocorrencias e devolve o texto novo e quantas foram trocadas.

    Aplica de tras para frente: substituir do inicio invalidaria os offsets das
    ocorrencias seguintes.
    """
    ordered = sorted(findings, key=lambda finding: finding.start, reverse=True)

    # Descarta sobreposicao: manter as duas corromperia o texto.
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
    """Mascara tudo menos os ultimos `visible` caracteres alfanumericos.

    Conta caracteres ALFANUMERICOS, e nao posicoes: mascarar por posicao em
    `111.444.777-35` deixaria visivel um hifen no lugar de um digito. Os
    separadores sao preservados, o que mantem o valor reconhecivel para o
    titular sem revelar o dado.
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
        # Permite correlacionar ocorrencias do mesmo valor sem revela-lo.
        digest = hashlib.sha256(original.encode("utf-8")).hexdigest()[:12]
        return f"<{entity_type}:{digest}>"
    return f"<{entity_type}>"
