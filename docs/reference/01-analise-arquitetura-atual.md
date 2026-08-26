# 01. Análise crítica da arquitetura atual (AIA Platform)

> Objetivo: avaliar a AIA Platform como base para uma plataforma corporativa de IA em um banco (contexto regulado: BACEN, LGPD), usando como critérios SOLID, KISS, Clean Code, Clean Architecture, resiliência, escalabilidade e segurança específica de LLM. O resultado alimenta a arquitetura alvo do documento 02.

## 1. Método de avaliação

Cada achado recebe:

- **Princípio afetado**: SRP, OCP, LSP, ISP, DIP, KISS, YAGNI, Clean Architecture (regra de dependência), resiliência, escalabilidade, segurança, regulatório.
- **Severidade**: Alta (bloqueia produção regulada ou cria ponto único de falha), Média (custo operacional ou dívida estrutural), Baixa (higiene).
- **Ação**: manter, ajustar, separar, unificar, remover.

Referências usadas na avaliação: OWASP Top 10 for LLM Applications 2025, Azure Well-Architected Framework para workloads de IA, arquitetura de referência "Baseline Foundry Chat" da Microsoft, capacidades de AI Gateway do Azure API Management, Resolução CMN 4.893/2021 (alterada pela Resolução CMN 5.274/2025) e LGPD (Lei 13.709/2018). Links completos no documento 02, seção Referências.

## 2. O que a AIA já faz bem

Antes dos problemas, o que deve ser preservado:

| Ponto forte | Por que importa |
|---|---|
| Gateway único para toda inferência (chat, embeddings, imagens, áudio) | É o único lugar onde governança, custo e auditoria podem ser aplicados de forma consistente. É o padrão de mercado (AI Gateway). |
| Model aliasing | Desacopla consumidores de nomes de deployment; permite trocar provedor e versão sem tocar nas aplicações. |
| Multi-provider e multi-região com fallback | Resiliência básica contra 429 e indisponibilidade regional. |
| Projeto como unidade de orçamento e acesso | É o embrião correto de multi-tenancy interna. |
| Frontend unificado com módulos | Reduz fragmentação de UX e de autenticação. |
| Arquitetura Medallion em ADX para custo e consumo | Base sólida para FinOps e showback. |
| Streaming SSE ponta a ponta | Necessário para UX de chat e agentes. |
| Poliglota com critério (TypeScript para domínio, Python onde o ecossistema de IA é mais maduro) | Escolha pragmática, desde que os contratos entre serviços sejam formais. |
| MCP como interface de agentes para bases de conhecimento | Aponta na direção do padrão de mercado para tools. |

## 3. Achados

### 3.1 `apl-back-project-management-aia` concentra quatro responsabilidades

**Observado**: um único serviço faz autenticação (PAT, app tokens, Entra ID), orçamento (cotas diárias e mensais), gestão de projetos (Jira) e consulta de consumo (ADX). Todos os outros backends dependem dele.

**Problema**: viola SRP no nível de serviço. Quatro razões distintas para mudar (política de identidade, regra financeira, integração com Jira, esquema analítico) concorrem no mesmo deploy, no mesmo banco e no mesmo ciclo de release. Um bug na integração com Jira pode derrubar a autenticação de toda a plataforma. Também é o ponto único de falha da arquitetura: o mapa de dependências mostra todos os serviços convergindo nele.

**Severidade**: Alta.

**Ação**: separar em `aia-identity` (identidade, tokens, autorização) e `aia-governance` (projetos, orçamentos, cotas, políticas de modelo, showback). Detalhes no documento 02, ADR-003.

### 3.2 Validação síncrona de token em todos os serviços

**Observado**: "quase todos os outros backends chamam `/auth/validate` para validar tokens de entrada".

**Problema**: cada request de negócio gera pelo menos uma chamada de rede extra antes de qualquer trabalho útil. Isso soma latência, multiplica a carga no serviço central e o transforma em gargalo de disponibilidade (se ele cai, ninguém autentica). Para tokens Entra ID (JWT assinado), a validação pode e deve ser local, com as chaves públicas (JWKS) cacheadas. Só tokens opacos (PAT) precisam de introspecção, e mesmo essa deve ter cache curto.

**Severidade**: Alta.

**Ação**: validação local de JWT via biblioteca compartilhada (um pacote NestJS e um pacote FastAPI), introspecção com cache para PAT, e identidade de serviço para chamadas máquina a máquina (Managed Identity ou client credentials), sem repassar o token do usuário onde não for necessário.

### 3.3 O Gateway reimplementa capacidades que já são commodity

**Observado**: `apl-back-gateway-aia` implementa round-robin entre regiões, fallback, controle de orçamento, coleta de métricas, proxy HTTP e aliasing, tudo em código próprio (NestJS + http-proxy-middleware).

**Problema**: não é errado construir um gateway próprio, mas parte do que foi construído (limite de tokens por consumidor, balanceamento com circuit breaker, cache semântico, inspeção de conteúdo) hoje é oferecida como política configurável em gateways de API maduros. O Azure API Management, por exemplo, oferece nativamente limite de tokens por consumidor, balanceamento round-robin, ponderado, por prioridade e com afinidade de sessão, circuit breaker com duração de abertura dinâmica baseada no header `Retry-After`, e cache semântico. Manter isso em código próprio significa manter, testar e evoluir infraestrutura que não diferencia o banco.

O que diferencia o banco e deve continuar em código próprio: regras de orçamento por projeto em moeda (não só tokens por minuto), políticas de acesso a modelos por time, guardrails específicos do negócio, auditoria com semântica bancária e o catálogo de aliases.

**Severidade**: Média (custo de manutenção e risco de bugs em infraestrutura crítica).

**Ação**: dividir o gateway em duas camadas: política de commodity no API Management (ou equivalente) e um `aia-inference-router` enxuto com as regras de negócio. ADR-002 no documento 02 discute as alternativas (manter tudo próprio, LiteLLM, Kong, APIM).

### 3.4 Fronteiras de dados ambíguas entre Graph API, Agent Studio e Knowledge Management

**Observado**: o Graph API é "catálogo de entidades" para agentes, tools, stores, colaboradores, times e siglas. O Agent Studio "usa o Graph API para persistir entidades" e ao mesmo tempo tem MongoDB próprio. O Knowledge Management também persiste stores no Graph e tem MongoDB próprio.

**Problema**: existe dupla fonte de verdade para a mesma entidade (definição do agente no Graph, estado do agente no Mongo do Studio). Isso viola a regra de que cada serviço é dono dos seus dados e cria dois modos de falha: inconsistência silenciosa e acoplamento de deploy (mudar o schema de "Agent" exige coordenar dois serviços). Além disso, o Graph mistura dois contextos delimitados sem relação: diretório organizacional (pessoas, times, siglas, alimentado por RH) e catálogo de ativos de IA (agentes, tools, stores).

**Severidade**: Alta.

**Ação**: um único `aia-registry` dono das *definições* de ativos de IA (agente, tool, prompt, store, modelo) e do diretório organizacional, com contextos separados internamente (módulos distintos, coleções distintas, ownership explícito). Os serviços de execução (agent runtime, knowledge) são donos apenas do *estado de execução* (checkpoints, índices, jobs) e referenciam ativos por ID. Sincronização por eventos, nunca por escrita cruzada.

### 3.5 Três runtimes de agentes no mesmo serviço

**Observado**: Agent Studio executa com "Internal Agent (LangChain padrão)", "Deep Agent" e "CrewAI".

**Problema**: violação direta de KISS. Três frameworks com modelos mentais diferentes de estado, memória, streaming e tool calling implicam três superfícies de bug, três formas de instrumentar telemetria e três formas de auditar decisões do agente. Em contexto regulado, cada runtime precisa passar pela mesma revisão de segurança (LLM06 Excessive Agency), o que triplica o custo.

**Severidade**: Média.

**Ação**: padronizar em um runtime (LangGraph, que já está presente e cobre single agent, multi-agent, human-in-the-loop e execução durável com checkpointer). Aplicar o padrão Strategy apenas se surgir um caso de uso que o runtime padrão comprovadamente não atende, e não antes (YAGNI).

### 3.6 Controle de orçamento síncrono e sem semântica de reserva

**Observado**: o Gateway "valida cotas antes de cada request (via apl-back-project-management-aia)"; o consumo real é calculado depois no ADX via pipeline Medallion.

**Problema**: existe uma janela entre validar e consumir na qual N requests concorrentes passam pela validação e estouram a cota juntas (race condition clássica). O custo real só aparece após o ETL, então o controle é sempre reativo. Há também acoplamento de latência com o serviço central (achado 3.2).

**Severidade**: Média.

**Ação**: padrão reserva e commit em Redis (operação atômica via script Lua): reservar tokens estimados antes da chamada, confirmar com tokens reais depois, liberar o excedente. O ADX permanece a fonte de verdade contábil, com reconciliação periódica que corrige os contadores. Detalhes no documento 02, seção Fluxos.

### 3.7 Resiliência parcial

**Observado**: há fallback de região e de modelo. Não há menção a timeouts explícitos por etapa, circuit breaker por backend, bulkhead por projeto, idempotência para requests não-streaming, tratamento de falha no meio de um stream, nem backpressure para ingestão.

**Problema**: retry sem circuit breaker amplifica incidentes (todos os clientes tentando de novo contra um backend degradado). Sem bulkhead, um projeto com bug em loop consome a capacidade dos outros. Sem idempotência, um retry de rede pode cobrar duas vezes. Em streaming, o fallback entre modelos só é possível antes do primeiro token; depois, o comportamento precisa ser definido (abortar com erro claro ou completar com outro modelo marcando a resposta).

**Severidade**: Alta (impacto direto em disponibilidade e custo).

**Ação**: catálogo explícito de políticas de resiliência por tipo de chamada (documento 02, seção Resiliência) implementado como decorators reutilizáveis nas bibliotecas compartilhadas.

### 3.8 Observabilidade proprietária e sem rastreamento distribuído

**Observado**: o Gateway "coleta métricas e envia para ADX". Não há menção a traces distribuídos entre frontend, gateway, agent studio, knowledge e Foundry, nem a padrão de atributos.

**Problema**: sem trace ponta a ponta, uma resposta ruim de agente não é reconstruível (qual tool foi chamada, com qual prompt, quantos tokens, qual modelo). O formato próprio em ADX impede usar ferramentas de mercado. A OpenTelemetry mantém, desde 2024, convenções semânticas para GenAI (`gen_ai.*`) que padronizam modelo, tokens de entrada e saída, motivo de parada, spans de agente e de tool. Adotá-las torna a telemetria portável entre Azure Monitor, Grafana, Datadog, MLflow e outros.

**Severidade**: Média.

**Ação**: OpenTelemetry em todos os serviços, convenções `gen_ai.*`, exportação para Azure Monitor (operacional) e ADX (analítico) a partir do mesmo collector. Conteúdo de prompts e completions gravado apenas com opt-in por projeto e com redação de PII.

### 3.9 Segurança específica de LLM ausente do desenho

**Observado**: a documentação cobre autenticação e orçamento. Não cobre injeção de prompt (direta e indireta via documentos RAG), agência excessiva de agentes, vazamento de system prompt, validação de saída antes de executar tools, isolamento do code interpreter, nem identidade por chamada nos endpoints MCP.

**Problema**: o OWASP Top 10 for LLM 2025 coloca injeção de prompt como risco número um e expande agência excessiva por causa de agentes com tools. Uma plataforma que executa agentes com web search, code interpreter, e-mail e calendário, dentro de um banco, precisa tratar cada tool como uma ação privilegiada com escopo mínimo e trilha de auditoria. Endpoints MCP sem identidade por request significam que qualquer agente com acesso ao servidor acessa tudo que o servidor acessa.

**Severidade**: Alta.

**Ação**: guardrails na borda (Azure AI Content Safety e Prompt Shields via política de gateway), classificação de tools por nível de risco com aprovação humana para ações consequentes, code interpreter em sandbox efêmero, MCP gateway com propagação de identidade do usuário e allow-list de tools por projeto, e testes de red team no pipeline. Mapeamento completo no documento 02, seção Segurança.

### 3.10 Processamento pesado executado de forma síncrona

**Observado**: Document Intelligence menciona "processamento assíncrono para documentos grandes", mas o pipeline de indexação do Knowledge Management (parse, chunk, embedding, armazenamento) é descrito como fluxo direto, sem fila.

**Problema**: ingestão de documentos e geração de embeddings são cargas de longa duração e com falha frequente (limites de taxa do provedor de embeddings, documentos corrompidos). Fazer isso na thread de uma request HTTP produz timeouts, retries duplicados e perda de trabalho.

**Severidade**: Média.

**Ação**: toda ingestão vira job em fila (Service Bus) processado por workers escaláveis com KEDA, com estado do job persistido, idempotência por hash do documento e dead-letter queue.

### 3.11 Scheduler em processo único

**Observado**: Data Factory usa APScheduler dentro de um FastAPI.

**Problema**: APScheduler em um único processo não tem alta disponibilidade nem semântica de "exactly once" entre réplicas. Duas réplicas executam o mesmo job duas vezes; zero réplicas não executam nenhum. Para pipeline financeiro (custo por projeto), isso é inaceitável.

**Severidade**: Média.

**Ação**: jobs como Container Apps Jobs (ou Azure Functions com timer trigger) orquestrados por agendamento externo, com lock distribuído e registro de execução. Alternativa para times de dados: Azure Data Factory ou Databricks Workflows.

### 3.12 Escopo além da plataforma

**Observado**: `apl-back-documentation-aia` é um CMS completo (categorias, portais, páginas, editor rich text, upload). `apl-back-chat-aia` é um CRUD de prompts. `apl-back-data-ingestion-aia` está vazio.

**Problema**: um CMS dentro da plataforma de IA compete com ferramentas que o banco já tem (Confluence, SharePoint, Backstage) e consome capacidade do time em algo que não é o produto. O serviço de chat, sendo só CRUD de prompts, não justifica um deploy próprio: prompts são ativos de IA e pertencem ao catálogo. Repositório vazio é YAGNI materializado.

**Severidade**: Baixa (mas consome capacidade).

**Ação**: documentação passa a ser fonte de ingestão para o Knowledge (conector para a wiki corporativa), não um produto; prompts migram para o `aia-registry` como tipo de ativo com versionamento; repositório vazio é removido.

### 3.13 Frontend acoplado a sete backends

**Observado**: o frontend usa uma "URL Factory" para chegar em sete serviços, com URLs internas do cluster ou de homologação.

**Problema**: o navegador conhece a topologia interna. Cada backend precisa expor CORS, cada um valida token à sua maneira, e a "URL Factory" é lógica de infraestrutura dentro da camada de apresentação.

**Severidade**: Baixa.

**Ação**: um único ponto de entrada (API Management) com roteamento por caminho (`/api/inference`, `/api/agents`, `/api/knowledge`). O frontend conhece uma URL base. A "URL Factory" desaparece.

### 3.14 Multi-tenancy implícita

**Observado**: "projeto" existe para orçamento, mas não aparece como dimensão obrigatória em cada request, em cada índice vetorial, em cada checkpoint de agente ou em cada log.

**Problema**: sem tenant explícito, o isolamento de dados entre áreas do banco depende de disciplina, não de estrutura. Em auditoria, "quem acessou o quê em nome de qual projeto" precisa ser respondido por consulta, não por reconstrução.

**Severidade**: Alta (regulatório).

**Ação**: `project_id` obrigatório em todo contrato (header ou claim), propagado como atributo de trace, chave de partição em bancos e filtro de segurança em buscas vetoriais (security trimming).

### 3.15 Ausência de LLMOps: avaliação, versionamento de prompts e regressão

**Observado**: não há serviço ou processo para avaliar qualidade de respostas, versionar prompts e system prompts, detectar regressão quando um modelo é atualizado ou descontinuado, nem coletar feedback humano de forma estruturada.

**Problema**: modelos gerenciados têm ciclo de vida curto (versões são descontinuadas em meses). Sem suíte de regressão, cada troca de modelo é um salto no escuro. A Microsoft recomenda tratar upgrade de modelo como promoção de código: rodar a suíte de prompts contra o candidato e comparar com produção antes de liberar.

**Severidade**: Média (vira Alta no primeiro incidente de regressão).

**Ação**: `aia-evaluation` com datasets versionados, avaliadores automáticos (groundedness, relevância, segurança), amostragem de tráfego de produção para avaliação online, gate de qualidade no CI e registro de prompts com versão.

### 3.16 Regulatório: residência de dados, PII em logs e auditoria

**Observado**: uso de Azure OpenAI em EastUS e EastUS2, logs de prompts em ADX, dados de RH ingeridos no Graph.

**Problema**: a Resolução CMN 4.893/2021 exige que a contratação de serviços relevantes de nuvem seja comunicada ao BACEN e, para serviços prestados no exterior, impõe requisitos adicionais (acesso da instituição e do BACEN aos dados, existência de convênio com autoridade supervisora, entre outros). Processar prompts que podem conter dados de clientes em regiões fora do Brasil é permitido, mas precisa estar documentado e governado. Logs de prompts com PII em ADX sem redação e sem política de retenção conflitam com a LGPD (minimização, finalidade, prazo).

**Severidade**: Alta.

**Ação**: classificação de dados por projeto (público, interno, confidencial, dados pessoais), roteamento de modelos condicionado à classificação (por exemplo, dados pessoais só em deployments dentro da zona de dados aprovada), redação de PII antes de log, retenção definida por política, trilha de auditoria imutável e inventário de fluxos de dados para o jurídico e o compliance.

## 4. Matriz resumo

| # | Achado | Princípio | Severidade | Ação |
|---|---|---|---|---|
| 3.1 | Project Management com 4 responsabilidades | SRP, ponto único de falha | Alta | Separar em identity e governance |
| 3.2 | `/auth/validate` síncrono em todos os serviços | DIP, resiliência | Alta | Validação local de JWT, cache de introspecção |
| 3.3 | Gateway reimplementa commodity | KISS, custo | Média | APIM para política + router enxuto |
| 3.4 | Dupla fonte de verdade (Graph vs Studio vs KM) | Ownership de dados | Alta | Registry único para definições; runtime só estado |
| 3.5 | Três runtimes de agente | KISS, YAGNI | Média | Padronizar em LangGraph |
| 3.6 | Orçamento síncrono sem reserva | Consistência | Média | Reserva e commit atômicos em Redis |
| 3.7 | Resiliência parcial | Resiliência | Alta | Catálogo de políticas como decorators |
| 3.8 | Telemetria proprietária sem tracing | Observabilidade | Média | OpenTelemetry com `gen_ai.*` |
| 3.9 | Sem controles específicos de LLM | Segurança (OWASP LLM) | Alta | Guardrails, tools por risco, MCP com identidade |
| 3.10 | Ingestão síncrona | Escalabilidade | Média | Filas e workers com KEDA |
| 3.11 | APScheduler em processo | Disponibilidade | Média | Jobs gerenciados com lock |
| 3.12 | CMS, CRUD de prompts e repo vazio | YAGNI, foco | Baixa | Conector de wiki; prompts no registry; remover vazio |
| 3.13 | Frontend conhece 7 backends | Clean Architecture | Baixa | Entrada única via APIM |
| 3.14 | Tenant implícito | Regulatório, isolamento | Alta | `project_id` obrigatório e propagado |
| 3.15 | Sem avaliação e versionamento | LLMOps | Média | Serviço de evaluation e gate no CI |
| 3.16 | Residência de dados e PII em logs | BACEN 4.893, LGPD | Alta | Classificação, roteamento por zona, redação |

## 5. Leitura por princípio

**SOLID no nível de serviços**

- SRP: violado em Project Management (3.1) e Graph (3.4). Respeitado em Knowledge, Document Intelligence e CodeGuardian.
- OCP: o aliasing de modelos e o multi-provider do gateway são bons exemplos de extensão sem modificação; os três runtimes de agente são o contraexemplo (cada novo runtime altera o serviço inteiro).
- LSP: os adapters de provedor (OpenAI, Anthropic) precisam ser substituíveis atrás de uma interface única de inferência; a documentação sugere endpoints distintos (`/chat/completions` e `/messages`), o que vaza o provedor para o consumidor. Recomendação: uma API canônica interna (compatível com OpenAI) e tradução nos adapters.
- ISP: consumidores do gateway recebem uma interface ampla (chat, embeddings, imagens, áudio). Aceitável se cada capacidade for um produto de API separado no gateway, com credenciais e cotas próprias.
- DIP: serviços dependem de implementações concretas (chamada HTTP direta a `/auth/validate`, cliente de Mongo no serviço). A arquitetura alvo introduz ports (interfaces) por serviço e adapters de infraestrutura.

**Clean Architecture dentro dos serviços**

Não é possível avaliar o código sem acesso a ele, mas a descrição sugere organização por camadas técnicas do framework (controllers, services, repositories do NestJS) e não por casos de uso. O documento 03 define a estrutura por serviço com regra de dependência explícita (domínio não conhece framework, aplicação não conhece banco, infraestrutura implementa ports) e um teste automatizado de arquitetura que falha o build quando a regra é quebrada.

**KISS e YAGNI**

Onze serviços funcionais para um MVP de plataforma é razoável se cada um tiver fronteira clara. A recomendação é reduzir para o núcleo (inference router, identity, governance, registry, agent runtime, knowledge, document processing, evaluation, data platform) e tratar CodeGuardian e futuros produtos como aplicações construídas sobre a plataforma com SDK, não como parte dela.

## 6. Conclusão

A AIA tem a topologia certa (gateway único, projeto como unidade de governança, frontend unificado, RAG e agentes como serviços) e as escolhas tecnológicas são defensáveis. Os problemas são de fronteira e de operação: responsabilidades concentradas, validação e orçamento síncronos, dados sem dono único, resiliência incompleta, ausência de controles de segurança específicos de LLM e ausência de LLMOps. Todos são corrigíveis sem trocar a stack. O documento 02 apresenta a arquitetura alvo que resolve cada achado e o documento 03 descreve como construí-la do zero.
