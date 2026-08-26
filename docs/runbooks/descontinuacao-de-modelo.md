# Descontinuacao de modelo anunciada

**Gatilho**: alerta 60 dias antes da data em `deprecatedAt` de um deployment, ou
anuncio do provedor.

Ciclo de vida de modelo e tratado como promocao de release, e nao como troca de
configuracao (doc 02, secao 11). Um modelo novo responde diferente, e "diferente"
em producao e um incidente.

## Acao

1. **Confirme quem usa.** Sem isso voce nao sabe o tamanho do problema.

   ```bash
   docker compose -f deploy/compose/docker-compose.yml exec -T mongo mongosh aia_router --quiet --eval '
   db.inference_audit.aggregate([
     { $match: { deploymentId: "openai-mini", occurredAt: { $gte: new Date(Date.now() - 30*24*3600*1000) } } },
     { $group: { _id: "$projectId", chamadas: { $sum: 1 } } },
     { $sort: { chamadas: -1 } }
   ])'
   ```

2. **Registre o candidato** no catalogo de aliases com prioridade MAIS ALTA que a
   do atual (numero maior), desabilitado.

3. **Rode a suite de regressao** contra o candidato:

   ```bash
   make eval SUITE=evals/suites/regressao-modelo
   ```

   Compare groundedness, relevancia, custo por resposta e latencia. Queda alem do
   limiar bloqueia a troca.

4. **Canario por projeto.** Habilite o candidato para um projeto voluntario,
   deixando o atual como fallback. Acompanhe por uma semana.

5. **Troque a prioridade** quando o canario estiver limpo: o candidato assume, o
   antigo vira fallback.

6. **Desabilite o antigo** apos duas semanas sem regressao, e so entao remova.

7. **Comunique os projetos** identificados no passo 1, com antecedencia e com os
   numeros da comparacao.

## Se a data chegar sem substituto aprovado

Melhor degradar de forma controlada do que quebrar: aponte o alias para o
deployment local (Ollama) e comunique a mudanca de qualidade. Uma resposta pior e
melhor que `no_compatible_deployment`.
