# Prontidao para producao (por servico)

Da secao 13 do documento 03. Use como gate: um servico so vai para producao com
todos os itens marcados, ou com a excecao registrada em ADR.

## Contrato

- [ ] OpenAPI ou AsyncAPI publicado em `contracts/`
- [ ] Erros em Problem Details com codigo estavel do catalogo
- [ ] Versionamento por caminho (`/v1`) e depreciacao com 90 dias de aviso
- [ ] `X-Project-Id` obrigatorio, ou a ausencia justificada
- [ ] `Idempotency-Key` em POST que cria recurso ou consome orcamento
- [ ] Paginacao por cursor opaco em toda lista

## Testes

- [ ] Unitarios de dominio (sem I/O) e de aplicacao (com fakes, nao mocks)
- [ ] **Todo caminho de erro tem teste**, e nao so o caminho feliz
- [ ] Teste de arquitetura passando, e comprovadamente capaz de reprovar
- [ ] Teste de contrato contra o OpenAPI
- [ ] Integracao com dependencia real em container
- [ ] Cobertura de dominio e aplicacao acima de 80%

## Observabilidade

- [ ] Traces com `aia.project_id` em todo span
- [ ] `gen_ai.*` nas chamadas de modelo (quando aplicavel)
- [ ] Logs estruturados, **sem PII**, com `trace_id`
- [ ] Metricas de SLI publicadas
- [ ] Dashboard e alertas de SLO

## Resiliencia

- [ ] Politica declarada de `@aia/resilience` (nao inventar retry)
- [ ] Degradacao graciosa definida e testada para cada dependencia
- [ ] Health checks separados: liveness nao consulta dependencia
- [ ] Graceful shutdown com drenagem de conexao
- [ ] Limites de CPU e memoria, HPA ou KEDA configurado

## Seguranca

- [ ] Sem segredo em variavel de ambiente (ADR-015)
- [ ] Autorizacao por Specification, com a decisao registrada no trace
- [ ] Imagem distroless, sem root, com filesystem somente leitura
- [ ] SBOM publicado, imagem assinada, sem vulnerabilidade critica com correcao
- [ ] Threat model revisado; tools classificadas por risco quando aplicavel

## Dados e regulatorio

- [ ] Classificacao de dados e retencao configuradas (TTL no banco)
- [ ] Redacao de PII antes de qualquer persistencia de conteudo
- [ ] Fluxo de dados no inventario do compliance
- [ ] Zona de dados registrada na auditoria (evidencia de residencia)

## Operacao

- [ ] Runbook escrito **e executado ao menos uma vez** em game day
- [ ] Dono definido (on-call)
- [ ] ADRs atualizados
