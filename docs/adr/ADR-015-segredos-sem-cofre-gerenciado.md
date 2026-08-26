# ADR-015: Segredos sem cofre gerenciado de nuvem

- **Status**: aceito (novo)
- **Data**: 2026-08-25

## Contexto

O documento 02 usa Azure Key Vault com Managed Identity, e proibe explicitamente
segredo em variavel de ambiente. A regra e correta; o mecanismo nao esta
disponivel fora da Azure.

## Decisao

Tres niveis, conforme onde a plataforma roda:

1. **Desenvolvimento**: arquivo `.env`, fora do Git, gerado de `.env.example`.
   Nenhum segredo real, e a chave de assinatura e gerada e persistida sozinha
   (ADR-004) — ninguem precisa gerar nem commitar nada.
2. **Self-host (compose de producao)**: Docker secrets a partir de arquivos em
   `deploy/compose/secrets/`, montados em `/run/secrets/`. Variavel de ambiente
   vaza em `docker inspect` e em log de crash; arquivo com permissao 600, nao.
3. **Kubernetes**: Secrets do cluster, com o caminho aberto para External Secrets
   Operator apontando para Vault, Infisical ou um cofre de nuvem.

**Regras que valem em todos os niveis:**

- Nenhum segredo no repositorio. O `gitleaks` varre o historico a cada PR.
- Chave de provedor ausente **desabilita aquele provedor** em vez de derrubar o
  servico. A plataforma sobe identica com zero, uma ou quatro chaves.
- Segredo de servico e comparado por HMAC com pepper, e o hash de senha usa
  Argon2id. Um vazamento do banco nao entrega credencial utilizavel.
- Rotacao e trocar a variavel e reiniciar: o bootstrap reescreve o hash.

## Alternativas consideradas

| Alternativa        | Por que nao como PADRAO                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| HashiCorp Vault    | Excelente e continua recomendado em producao. Exigir Vault para rodar localmente afastaria quem so quer experimentar. |
| Infisical          | Mesma consideracao; e a opcao mais simples de operar das duas.                                                        |
| SOPS com chave age | Boa para GitOps. Cabe como complemento, nao substitui o cofre em runtime.                                             |

## Consequencias

**Mais facil**: nenhuma dependencia de cofre para comecar. `make dev` funciona
sem nenhum segredo real.

**Mais dificil**: em self-host, a rotacao e manual. O runbook de rotacao de
segredo cobre o procedimento.

**Limite explicito**: este ADR nao entrega auditoria de acesso a segredo nem
rotacao automatica. Quem precisa disso — e uma instituicao regulada precisa —
usa Vault ou Infisical no nivel 3.
