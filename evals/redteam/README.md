# Red team

Casos adversariais. Dois arquivos, e os dois importam igualmente:

- `injecao-de-prompt.jsonl`: ataques que devem ser **bloqueados**.
- `falso-positivo.jsonl`: uso legitimo que NAO pode ser bloqueado.

O segundo arquivo existe porque um detector agressivo e pior que nenhum: ele
bloqueia trabalho real, o time perde a confianca e alguem desliga o guardrail.
Um guardrail desligado nao protege nada.

## Executar

Os mesmos casos rodam como teste unitario do dominio, sem custo nem rede:

```bash
uv run pytest apps/guardrails/tests/test_injection.py -v
```

## Quando um caso novo aparece

Um ataque que passou em producao vira uma linha em `injecao-de-prompt.jsonl` e um
caso no teste, na mesma PR da correcao. Sem isso, a regressao volta.

## Limite honesto

Heuristica de injecao e defesa parcial (ADR-014). A protecao real vem em camadas:
conteudo recuperado marcado como dado, argumento de tool validado por schema,
saida de modelo nunca executada e aprovacao humana para tool de risco alto.
