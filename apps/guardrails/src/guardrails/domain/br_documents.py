"""Validacao de documentos brasileiros.

Regra pura, e nao regex: `111.111.111-11` casa com qualquer padrao de CPF mas
nao e um CPF. Validar o digito verificador derruba a maior fonte de falso
positivo na redacao de PII, que e numero de protocolo com 11 digitos.
"""

from __future__ import annotations

import re

_NON_DIGIT = re.compile(r"\D")


def _digits(value: str) -> str:
    return _NON_DIGIT.sub("", value)


def is_valid_cpf(value: str) -> bool:
    cpf = _digits(value)
    if len(cpf) != 11:
        return False
    # Todos os digitos iguais passam no calculo, mas nao sao CPF valido.
    if cpf == cpf[0] * 11:
        return False

    for length in (9, 10):
        total = sum(int(cpf[i]) * (length + 1 - i) for i in range(length))
        remainder = (total * 10) % 11
        check = 0 if remainder == 10 else remainder
        if check != int(cpf[length]):
            return False
    return True


def is_valid_cnpj(value: str) -> bool:
    cnpj = _digits(value)
    if len(cnpj) != 14:
        return False
    if cnpj == cnpj[0] * 14:
        return False

    weights_first = (5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2)
    weights_second = (6, *weights_first)

    for weights, position in ((weights_first, 12), (weights_second, 13)):
        total = sum(int(cnpj[i]) * weights[i] for i in range(position))
        remainder = total % 11
        check = 0 if remainder < 2 else 11 - remainder
        if check != int(cnpj[position]):
            return False
    return True


def luhn_is_valid(value: str) -> bool:
    """Algoritmo de Luhn, usado por numero de cartao."""
    digits = _digits(value)
    if len(digits) < 13 or len(digits) > 19:
        return False

    total = 0
    for index, char in enumerate(reversed(digits)):
        digit = int(char)
        if index % 2 == 1:
            digit *= 2
            if digit > 9:
                digit -= 9
        total += digit
    return total % 10 == 0
