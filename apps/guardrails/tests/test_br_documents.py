"""Validation of Brazilian identifiers.

These tests exist because the difference between `\\d{11}` and a real CPF is what
separates a useful redaction from one that erases half the numbers in the text.
"""

from __future__ import annotations

import pytest

from guardrails.domain.br_documents import is_valid_cnpj, is_valid_cpf, luhn_is_valid


class TestCpf:
    @pytest.mark.parametrize(
        "cpf",
        ["111.444.777-35", "11144477735", "529.982.247-25", "52998224725"],
    )
    def test_accepts_a_valid_cpf_with_or_without_a_mask(self, cpf: str) -> None:
        assert is_valid_cpf(cpf)

    @pytest.mark.parametrize(
        "cpf",
        [
            "111.444.777-36",  # wrong check digit
            "123.456.789-00",  # a common sequence, invalid
            "1234567890",  # too few digits
            "123456789012",  # too many digits
            "",
            "abc.def.ghi-jk",
        ],
    )
    def test_rejects_an_invalid_cpf(self, cpf: str) -> None:
        assert not is_valid_cpf(cpf)

    @pytest.mark.parametrize("repeated", [f"{d}" * 11 for d in "0123456789"])
    def test_rejects_all_identical_digits(self, repeated: str) -> None:
        # They pass the check-digit calculation but are not CPFs: they are the
        # classic source of false positives on ticket numbers.
        assert not is_valid_cpf(repeated)


class TestCnpj:
    @pytest.mark.parametrize("cnpj", ["11.222.333/0001-81", "11222333000181"])
    def test_accepts_a_valid_cnpj(self, cnpj: str) -> None:
        assert is_valid_cnpj(cnpj)

    @pytest.mark.parametrize("cnpj", ["11.222.333/0001-82", "11222333000100", "1122233300018", ""])
    def test_rejects_an_invalid_cnpj(self, cnpj: str) -> None:
        assert not is_valid_cnpj(cnpj)

    def test_rejects_all_identical_digits(self) -> None:
        assert not is_valid_cnpj("11111111111111")


class TestLuhn:
    @pytest.mark.parametrize(
        "number", ["4111111111111111", "4111 1111 1111 1111", "5500005555555559"]
    )
    def test_accepts_a_valid_card(self, number: str) -> None:
        assert luhn_is_valid(number)

    @pytest.mark.parametrize("number", ["4111111111111112", "1234567890123456", "123"])
    def test_rejects_a_number_that_fails_luhn(self, number: str) -> None:
        assert not luhn_is_valid(number)
