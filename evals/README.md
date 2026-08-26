# Avaliacao (evals)

Qualidade medida, nao presumida (doc 02, principio 10).

Um prompt que "parece melhor" nao e melhor: e uma opiniao. Estas suites existem
para transformar isso em numero, e para que uma regressao apareca no CI em vez
de aparecer no usuario.

## Estrutura

```
evals/
├── datasets/   perguntas com resposta de referencia, versionadas
├── suites/     o que medir e qual o limiar de reprovacao
└── redteam/    casos adversariais (injecao, jailbreak, exfiltracao)
```

## Quando roda

| Momento                                  | O que roda                   | Bloqueia?                        |
| ---------------------------------------- | ---------------------------- | -------------------------------- |
| Mudanca de prompt, alias ou chunking     | Suite do caso de uso afetado | Sim, abaixo do limiar            |
| Antes de trocar o deployment de um alias | Suite de regressao de modelo | Sim                              |
| Semanal e antes de release               | Red team                     | Sim, se um caso conhecido passar |
| Producao                                 | Amostra de 1 a 5% do trafego | Nao, alerta                      |

## Por que o limiar nao e 100%

Um limiar impossivel e desligado na primeira semana. Os limiares aqui sao o
**piso do que ja foi medido**, e sobem quando o sistema melhora — nunca o
contrario.

## Custo

Avaliacao consome inferencia de verdade. Rode contra o projeto `platform-ci`,
que tem orcamento proprio, e prefira o alias local (`chat-local`) para as suites
que nao dependem da qualidade de um provedor especifico.

## Estado atual

A estrutura e os datasets estao aqui; o executor (`aia-evaluation`) e um
esqueleto gerado e entra na Fase 2 do roadmap. Os datasets ja sao uteis para
teste manual e para o red team.
