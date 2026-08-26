# Checklist do Sprint 0

Da secao 11 do documento 03, adaptado para a versao open source e agnostica de
cloud. Marcado o que ja esta feito neste repositorio.

## Fundacoes

- [x] Nome, dominio interno e convencao de nomes (`aia-<servico>`, `@aia/<pacote>`, `aia_<pacote>`)
- [x] Monorepo com a estrutura da secao 2, `CODEOWNERS`, templates de PR e de ADR
- [x] Bibliotecas compartilhadas nas duas linguagens, com testes
- [x] Geradores de servico produzindo o esqueleto da secao 3
- [x] Contratos OpenAPI iniciais (router, identity, governance, guardrails)
- [x] Contrato AsyncAPI dos eventos, com envelope CloudEvents
- [x] Pipeline de CI com todos os estagios da secao 8
- [x] ADR-001 a ADR-015 escritos e revisaveis

## Substituindo o que era da cloud

- [x] Ambiente local completo em containers (sem nenhuma conta de cloud)
- [x] Emissor de identidade proprio, com JWKS e chave persistida
- [x] Credencial de servico por `client_credentials` (no lugar de Managed Identity)
- [x] Guardrails proprios com redacao de PII brasileira
- [x] Observabilidade com OTel Collector e Grafana LGTM
- [x] Empacotamento para self-host (compose de producao) e Kubernetes (Helm)

## Antes de ir para producao

- [ ] Segredos migrados para Vault ou Infisical (ADR-015, nivel 3)
- [ ] Chave de assinatura de token gerada e guardada no cofre
- [ ] Backup do MongoDB automatizado e **restauracao testada**
- [ ] Dashboard com os SLOs do documento 02, secao 11
- [ ] Alertas: orcamento em 50/80/100%, circuito aberto, fila crescendo, outbox parada
- [ ] Projeto `platform-ci` com orcamento proprio para avaliacoes
- [ ] Conversa com compliance e DPO: classificacao, regioes, retencao
- [ ] Game day executando pelo menos tres runbooks

## Time minimo para continuar

O documento 03 sugere de 8 a 12 pessoas para o roadmap completo. Para as Fases 0
e 1 desta versao, o minimo real e menor:

| Papel                  | Quantidade |
| ---------------------- | ---------- |
| Backend TypeScript     | 2          |
| Backend Python / IA    | 1          |
| Plataforma (SRE)       | 1          |
| Seguranca de aplicacao | parcial    |
| Product owner          | 1          |
