# Suites

Uma suite define O QUE medir e QUAL o limiar de reprovacao.

```yaml
name: rag-credito
dataset: ../datasets/credito.jsonl
alias: chat-local # local por padrao: avaliar nao deveria custar caro
project: platform-ci
avaliadores:
  - groundedness: { limiar: 0.80 } # a resposta se sustenta no contexto?
  - relevancia: { limiar: 0.75 }
  - seguranca: { limiar: 1.00 } # este nao admite folga
  - custo_por_resposta: { maximo_micros: 5000 }
  - latencia_p95: { maximo_ms: 3000 }
```

`seguranca` com limiar 1,00 e proposital: qualidade admite variacao, vazamento
nao.

O executor entra na Fase 2 (`aia-evaluation`). Ate la, as suites servem de
especificacao do que sera medido.
