# ADR-004: Validacao local de JWT com JWKS

- **Status**: aceito
- **Data**: 2026-08-25

## Contexto

O achado 3.2 do documento 01: todo servico chamava `/auth/validate` antes de
qualquer trabalho util. Isso soma latencia a cada requisicao, multiplica a carga
no servico central e o torna gargalo de DISPONIBILIDADE — se ele cai, ninguem
autentica.

Um JWT e assinado. A assinatura pode ser verificada com a chave publica, sem
perguntar nada a ninguem.

## Decisao

- `@aia/auth` (TypeScript) e `aia_auth` (Python) validam o JWT localmente, com o
  JWKS em cache.
- O `aia-identity` publica `/.well-known/jwks.json`.
- **A chave de assinatura e persistida**, e nao gerada em memoria: chave efemera
  invalida todo token emitido a cada restart e ainda deixa os outros servicos com
  JWKS obsoleto em cache, produzindo 401 sem causa aparente. Em producao a chave
  vem da configuracao; em desenvolvimento e gerada uma vez e guardada no MongoDB.
- Token opaco (PAT) precisa de introspeccao, com cache de 60 s.
- **Servico a servico** usa o grant `client_credentials`: o proprio identity emite
  a credencial. Sem uma nuvem que forneca identidade gerenciada, e assim que um
  servico prova quem e para outro.

## Alternativas consideradas

| Alternativa                          | Por que nao                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Introspeccao para todo token         | E o problema que este ADR resolve.                                                                                                                                     |
| Segredo compartilhado entre servicos | Um segredo unico que vaza compromete tudo, e rotacionar exige reiniciar todos ao mesmo tempo.                                                                          |
| mTLS entre servicos                  | Resolve autenticacao de servico, mas nao carrega escopo nem identidade de usuario, e a operacao de PKI e desproporcional aqui. Continua valendo como camada adicional. |

## Consequencias

**Mais facil**: uma requisicao autenticada nao gera nenhuma chamada de rede
extra. O identity pode reiniciar sem derrubar a plataforma.

**Mais dificil**: revogar um JWT antes do vencimento nao e imediato. A mitigacao
e TTL curto (1 h por padrao) e revogacao imediata para PAT.

**Exige atencao**: rotacao de chave precisa manter a chave antiga no JWKS ate os
tokens emitidos com ela expirarem. O verificador Python recarrega o JWKS quando
encontra assinatura desconhecida, para nao quebrar durante a rotacao.
