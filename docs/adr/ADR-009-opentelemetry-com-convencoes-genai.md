# ADR-009: OpenTelemetry com convencoes GenAI

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

Telemetria de IA tem perguntas proprias: quantos tokens, qual modelo, quanto
custou, quanto tempo ate o primeiro token, por que a resposta parou. Sem
convencao, cada servico inventa um nome de atributo e nenhuma consulta funciona
para a plataforma inteira.

## Decisao

- **OpenTelemetry** em todos os servicos, nos dois ecossistemas.
- **Semantic Conventions for Generative AI** para as chamadas de modelo:
  `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, com spans
  nomeados `{operacao} {modelo}`.
- **Atributos `aia.*`** de negocio em todo span: `project_id` sempre, mais
  `principal_id`, `alias`, `data_classification`, `deployment_id`, `data_zone`.
- A instrumentacao das chamadas de modelo fica no `DeploymentExecutor`, e nao em
  cada adapter: assim os quatro provedores emitem os MESMOS atributos, e um
  provedor novo herda a telemetria correta sem que ninguem precise lembrar.
- **Conteudo de prompt e resposta so com opt-in do projeto**, e depois da redacao
  de PII.

Destino: um endpoint OTLP. Em desenvolvimento, a imagem `grafana/otel-lgtm`;
em producao, qualquer coisa que fale OTLP.

## Alternativas consideradas

| Alternativa                                | Por que nao                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| Log estruturado com campos proprios        | Nao correlaciona entre servicos e nao responde "onde o tempo foi gasto". |
| SDK de observabilidade de LLM proprietario | Prende a plataforma a um fornecedor, contra o ADR-012.                   |
| Convencao propria de atributos             | Nenhuma ferramenta entenderia sem tradutor.                              |

## Consequencias

**Mais facil**: a mesma consulta funciona no Tempo, no Jaeger, no Grafana Cloud
ou em qualquer backend OTLP. Custo por projeto sai de uma agregacao sobre spans.

**Mais dificil**: as convencoes GenAI ainda evoluem. Os nomes ficam centralizados
em `@aia/telemetry` e `aia_telemetry`, entao acompanhar uma mudanca e editar um
arquivo por linguagem.
