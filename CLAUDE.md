# Convenções deste repositório

Plataforma de IA open source e agnóstica de cloud. Monorepo poliglota: NestJS e
FastAPI, com bibliotecas compartilhadas espelhadas nas duas linguagens.

## Comandos

```bash
make bootstrap    # instala pnpm, uv e dependências
make dev          # sobe tudo em containers
make check        # o que o CI roda: lint, tipos, arquitetura, testes
make arch         # só a regra de dependência
make e2e          # fluxo 7.1 contra o ambiente local
make contracts    # regera tipos a partir de contracts/openapi
```

`pnpm` e `uv` ficam em `~/.local/bin` — o Makefile já ajusta o PATH.

## Regra de dependência — não negociável

Dependências apontam **para dentro**:

```
presentation  →  application  →  domain
infrastructure ─implementa→ ports (em application/)
```

- `domain/` é código puro: sem framework, sem I/O, sem relógio, sem `@nestjs`,
  sem `fastapi`, sem cliente de banco.
- `application/` fala só com **ports** (interfaces / `Protocol`), nunca com
  adapters.
- O wiring (`*.module.ts`, `container.py`) é o único lugar que conhece as três
  camadas.
- Nenhum serviço importa domínio de outro. Use contratos.

`make arch` reprova. O CI vai além: introduz uma violação de propósito e falha se
a regra não pegar.

## Onde colocar o quê

| Você está escrevendo                    | Vai em                               |
| --------------------------------------- | ------------------------------------ |
| Regra de negócio pura                   | `domain/`                            |
| Orquestração de um caso de uso          | `application/use-cases/`             |
| Interface de dependência externa        | `application/ports.ts` ou `ports.py` |
| Cliente de banco, HTTP, provedor        | `infrastructure/`                    |
| Controller, SSE, consumer de fila       | `presentation/`                      |
| Comportamento usado por vários serviços | `packages/` ou `python/`             |

Se algo é útil para dois serviços, é biblioteca compartilhada — não copie.

## Bibliotecas compartilhadas

| TypeScript        | Python           | O quê                                           |
| ----------------- | ---------------- | ----------------------------------------------- |
| `@aia/errors`     | `aia_errors`     | Problem Details (RFC 9457), catálogo de códigos |
| `@aia/auth`       | `aia_auth`       | JWT local com JWKS, Principal, RBAC/ABAC        |
| `@aia/resilience` | `aia_resilience` | Timeout, retry, circuit breaker, bulkhead       |
| `@aia/telemetry`  | `aia_telemetry`  | OTel com `gen_ai.*` e `aia.*`                   |
| `@aia/messaging`  | `aia_messaging`  | CloudEvents, outbox, Redis Streams              |
| `@aia/nest`       | —                | Cola HTTP: filtro, guard, health                |

**Nunca reinvente retry, timeout ou circuit breaker.** Use `POLICIES` do
`@aia/resilience`; os valores vêm da tabela do doc 02 §8.

## Padrões que valem em todo lugar

**Erros**: exceção de domínio tipada, com código estável do catálogo. Nunca
retorne `null` para indicar erro, nunca engula exceção. Erro desconhecido vira
500 sem detalhe — a mensagem interna vai só para o log.

**Tenant**: `project_id` é obrigatório em todo contrato, evento, trace e chave de
partição. Uma rota que não opera sobre projeto declara `@NoProject()`.

**Configuração**: validada no boot com zod ou pydantic-settings. A aplicação
**não sobe** com configuração inválida.

**Segredos**: nunca em código, nunca em variável commitada. Chave de provedor
ausente desabilita aquele provedor, não derruba o serviço.

**Telemetria**: todo span carrega `aia.project_id`. Chamada de modelo carrega
`gen_ai.*`. Conteúdo de prompt só com opt-in do projeto, e depois da redação.

**Testes**: fakes, não mocks. O teste verifica comportamento, não sequência de
chamadas. **Todo caminho de erro tem teste** — o caminho feliz é o mais fácil e o
menos informativo.

## Comentários

Explique **por quê**, nunca **o quê**. O código já diz o quê.

```ts
// Ruim: incrementa o contador de reservas
// Bom:  script Lua porque entre ler e gravar outra réplica leria o mesmo saldo
```

Comente decisão não óbvia, trade-off assumido, e o motivo de um jeito estranho
ser o certo. Se a decisão é estrutural, o lugar dela é um ADR.

## Convenções de nome

- Serviço: `aia-<nome>` em kebab-case. Pacote TS: `@aia/<nome>`. Python: `aia_<nome>`.
- Caso de uso: verbo (`CreateChatCompletion`). Entidade: substantivo (`BudgetReservation`).
- Evento: `aia.<domínio>.<fato>.v<N>` — mudança incompatível cria novo tipo.
- Código de erro: `snake_case` estável, no catálogo de `@aia/errors`.

## Contratos

Contract-first. O YAML em `contracts/openapi/` é a fonte; os tipos são gerados. O
CI falha se divergirem. Mudou a API? Mude o contrato primeiro.

## Serviço novo

```bash
node tools/generators/new-service.mjs --name meu-servico --runtime node --port 3010
```

Produz o esqueleto correto por construção. Não copie um serviço existente.

## Antes de abrir PR

- `make check` passa
- Contrato atualizado se a API mudou
- Caminhos de erro cobertos
- ADR criado ou atualizado se a decisão é estrutural
- Conventional Commits

## Contexto

`docs/reference/` traz os documentos de arquitetura originais, que assumem Azure.
Esta implementação é agnóstica de cloud — onde divergimos, o ADR correspondente
explica o quê e o porquê. Leia `docs/adr/README.md` antes de propor mudança
estrutural.
