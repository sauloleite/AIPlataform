"""Validacao de documentos brasileiros.

Estes testes existem porque a diferenca entre `\\d{11}` e um CPF de verdade e o
que separa uma redacao util de uma que apaga metade dos numeros do texto.
"""

from __future__ import annotations

import pytest

from guardrails.domain.br_documents import is_valid_cnpj, is_valid_cpf, luhn_is_valid


class TestCpf:
    @pytest.mark.parametrize(
        "cpf",
        ["111.444.777-35", "11144477735", "529.982.247-25", "52998224725"],
    )
    def test_aceita_cpf_valido_com_ou_sem_mascara(self, cpf: str) -> None:
        assert is_valid_cpf(cpf)

    @pytest.mark.parametrize(
        "cpf",
        [
            "111.444.777-36",  # digito verificador errado
            "123.456.789-00",  # sequencia comum, invalida
            "1234567890",  # digitos de menos
            "123456789012",  # digitos de mais
            "",
            "abc.def.ghi-jk",
        ],
    )
    def test_recusa_cpf_invalido(self, cpf: str) -> None:
        assert not is_valid_cpf(cpf)

    @pytest.mark.parametrize("repeated", [f"{d}" * 11 for d in "0123456789"])
    def test_recusa_todos_os_digitos_iguais(self, repeated: str) -> None:
        # Passam no calculo do digito, mas nao sao CPF: sao a fonte classica de
        # falso positivo em numero de protocolo.
        assert not is_valid_cpf(repeated)


class TestCnpj:
    @pytest.mark.parametrize("cnpj", ["11.222.333/0001-81", "11222333000181"])
    def test_aceita_cnpj_valido(self, cnpj: str) -> None:
        assert is_valid_cnpj(cnpj)

    @pytest.mark.parametrize("cnpj", ["11.222.333/0001-82", "11222333000100", "1122233300018", ""])
    def test_recusa_cnpj_invalido(self, cnpj: str) -> None:
        assert not is_valid_cnpj(cnpj)

    def test_recusa_todos_os_digitos_iguais(self) -> None:
        assert not is_valid_cnpj("11111111111111")


class TestLuhn:
    @pytest.mark.parametrize(
        "number", ["4111111111111111", "4111 1111 1111 1111", "5500005555555559"]
    )
    def test_aceita_cartao_valido(self, number: str) -> None:
        assert luhn_is_valid(number)

    @pytest.mark.parametrize("number", ["4111111111111112", "1234567890123456", "123"])
    def test_recusa_numero_que_nao_passa_no_luhn(self, number: str) -> None:
        assert not luhn_is_valid(number)
