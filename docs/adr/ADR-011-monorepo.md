# ADR-011: Monorepo para o nucleo

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

A plataforma tem servicos em duas linguagens, contratos compartilhados entre
elas, cinco bibliotecas transversais e infraestrutura versionada.

O problema real de um polyrepo aqui: mudar um contrato exige uma PR no repositorio
de contratos, esperar publicar, e depois PRs em cada consumidor. Durante esse
intervalo o sistema esta inconsistente e ninguem sabe.

## Decisao

Um monorepo com pnpm workspaces (TypeScript), uv workspace (Python) e Nx para
build por afetados. Contratos, bibliotecas, servicos, infraestrutura e
documentacao no mesmo lugar. Produtos que apenas consomem a plataforma pelo SDK
ficam em repositorios proprios.

## Alternativas consideradas

| Alternativa               | Por que nao                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| Polyrepo                  | Mudanca de contrato deixa de ser atomica.                            |
| Monorepo so de TypeScript | Deixaria os servicos Python fora dos mesmos contratos e do mesmo CI. |

## Consequencias

**Mais facil**: mudar um contrato e seus consumidores em UMA PR, com o CI
verificando os dois lados juntos. A regra de dependencia da Clean Architecture e
verificavel em todo o codigo de uma vez.

**Mais dificil**: o CI precisa de build seletivo, senao toda PR roda tudo.
Resolvido com `nx affected` e `uv`.

**Exige disciplina**: proximidade fisica nao autoriza acoplamento. O
`dependency-cruiser` proibe explicitamente um servico importar dominio de outro,
e o CI prova que a regra realmente reprova quando violada.
