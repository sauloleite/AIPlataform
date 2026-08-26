# ADR-010: Roteamento de modelo condicionado a classificacao de dados

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

Uma instituicao regulada precisa provar ONDE cada dado foi processado. Nao basta
ter uma politica escrita: e preciso que a arquitetura torne a violacao
impossivel, e que a evidencia seja gerada automaticamente.

Na versao original isso significava escolher entre deployments do Foundry em
regioes diferentes. Aqui significa algo mais forte: escolher entre um modelo que
roda na propria maquina e um provedor externo.

## Decisao

- Cada **projeto** declara uma classificacao: `publico`, `interno`,
  `confidencial` ou `restrito`.
- Cada **deployment** declara uma zona de dados: `local`, `br`, `us`, `eu` ou
  `global`.
- O `ModelSelectionPolicy` — regra PURA de dominio, sem I/O — so escolhe
  deployments cuja zona seja compativel com a classificacao.
- A politica do projeto pode **restringir** as zonas, nunca ampliar.
- Sem destino compativel, a requisicao FALHA com `no_compatible_deployment`.
  Enviar assim mesmo seria a violacao.
- A zona escolhida vai para a auditoria e para o evento `UsageRecorded`.

Mapeamento: `restrito` so aceita `local`; `confidencial` aceita `local` e `br`;
`interno` e `publico` aceitam qualquer zona. Classificacao desconhecida falha
FECHADA.

## Consequencias

**O que isso resolve na pratica**: um projeto `restrito` pedindo o alias
`chat-rapido` — que tem Gemini, OpenAI e Ollama — e atendido pelo Ollama, na
propria maquina. O provedor externo nem chega a ser chamado. Sem cloud nenhuma, a
plataforma resolve o caso "dado sensivel nao sai daqui".

**Evidencia automatica**: a coluna `data_zone` na auditoria e a prova de
residencia. Ninguem precisa se lembrar de registrar nada.

**Mais dificil**: um alias precisa ter cobertura em zona local para servir
projetos restritos. Um alias so com provedor externo simplesmente nao aparece
para eles no `GET /v1/models` — melhor nao oferecer do que recusar na hora do uso.
