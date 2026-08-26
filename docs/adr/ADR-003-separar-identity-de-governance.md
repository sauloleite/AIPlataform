# ADR-003: Separar identidade de governanca

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

O achado 3.1 do documento 01: um unico servico concentrava autenticacao,
orcamento, gestao de projetos e consulta de consumo. Quatro razoes distintas para
mudar competindo pelo mesmo deploy e pelo mesmo banco — e todo servico da
plataforma dependia dele, o que fazia dele o ponto unico de falha.

## Decisao

Dois servicos com bancos proprios:

- **`aia-identity`**: quem e voce. Emissao de token, PAT, papeis, JWKS.
- **`aia-governance`**: o que voce pode gastar e para onde o dado pode ir.
  Projetos, orcamento em moeda, classificacao de dados, politicas de modelo.

## Alternativas consideradas

| Alternativa                                   | Por que nao                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monolito modular com dois modulos             | Aceitavel para time pequeno, e a fronteira interna precisa ser mantida por disciplina. Como a plataforma ja e poliglota e distribuida, o custo de dois deploys e baixo perto do risco de erodir a fronteira. |
| Tres servicos (separar orcamento de projetos) | Orcamento e projeto mudam pela mesma razao: sao a mesma decisao de negocio.                                                                                                                                  |

## Consequencias

**Mais facil**: uma mudanca em politica de orcamento nao pode derrubar a
autenticacao. Ciclos de release independentes.

**Mais dificil**: mais um deploy, e uma chamada de rede a mais entre eles. O
router mitiga com cache local de politica (`policy_stale`).

**Efeito colateral bom**: como o identity sai do caminho critico (ADR-004), a
disponibilidade da plataforma passou a nao depender dele para requisicoes ja
autenticadas.
