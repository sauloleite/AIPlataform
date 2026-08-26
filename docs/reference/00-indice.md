# AIA 2.0: plataforma corporativa de IA para instituição financeira

Pacote de documentação para analisar a AIA Platform e construir, do zero, uma plataforma "AI First" própria em uma instituição regulada (BACEN, LGPD), com Azure como cloud primária e stack poliglota (NestJS + FastAPI).

## Ordem de leitura

| Arquivo | O que contém | Para quem |
|---|---|---|
| `01-analise-arquitetura-atual.md` | Avaliação da AIA contra SOLID, KISS, Clean Architecture, resiliência, escalabilidade, segurança de LLM e regulatório. 16 achados com severidade e ação. | Arquitetura, liderança técnica |
| `02-arquitetura-alvo.md` | Princípios, catálogo de serviços, de/para, contratos, identidade e multi-tenancy, fluxos (sequence diagrams), resiliência, escalabilidade, segurança (OWASP LLM, LGPD, CMN 4.893), observabilidade e LLMOps, 11 ADRs, referências. | Arquitetura, segurança, compliance |
| `03-guia-implementacao-do-zero.md` | Equipe, monorepo, Clean Architecture por serviço (templates NestJS e FastAPI com código), padrões de projeto, Clean Code, contratos, testes, CI/CD, IaC, roadmap em 6 fases, checklist de Sprint 0, runbooks, checklist de produção. | Engenharia, SRE |
| `04-pecas-cloud.md` | Todas as peças de cloud por categoria, com equivalentes em AWS e GCP, fase de adoção, residência de dados e dimensionamento inicial. | Infraestrutura, FinOps, compras |
| `aia-2.0-arquitetura-alvo.mermaid` | Diagrama completo da arquitetura alvo. | Todos |

## Resumo das decisões

1. API Management como entrada única e como AI Gateway (token limit, content safety, balanceamento com circuit breaker, cache semântico).
2. `aia-inference-router` próprio e enxuto: API canônica compatível com OpenAI, aliasing, orçamento em moeda com reserva e commit atômicos, políticas por classificação de dados, auditoria.
3. Project Management dividido em `aia-identity` e `aia-governance`; JWT validado localmente; serviço a serviço com Managed Identity.
4. `aia-registry` como dono único das definições de ativos de IA (agentes, tools, prompts versionados, stores, modelos) e do diretório; runtimes só guardam estado de execução.
5. Um runtime de agentes (LangGraph) com execução durável e aprovação humana; tools atrás de `aia-mcp-gateway` com identidade do usuário por chamada.
6. Ingestão, extração e avaliação assíncronas via Service Bus e workers com KEDA.
7. OpenTelemetry com convenções `gen_ai.*`; Azure Monitor para operação, Data Explorer para análise e auditoria.
8. `aia-evaluation` com gate de regressão no CI e avaliação online por amostragem; ciclo de vida de modelos tratado como release.
9. Projeto como tenant obrigatório em todo contrato, evento, trace, partição e filtro de busca.
10. Roteamento de modelos condicionado à classificação de dados, gerando evidência de residência para BACEN e LGPD.
11. Remoção do CMS de documentação, do CRUD de prompts como serviço e do repositório vazio.

## Próximos passos sugeridos

1. Validar os ADRs com arquitetura, segurança e compliance.
2. Executar o checklist de Sprint 0 (documento 03, seção 11).
3. Iniciar a Fase 0 com o time mínimo da seção 1 do documento 03.
