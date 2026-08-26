# ADR-014: Guardrails proprios com Presidio

- **Status**: aceito (novo)
- **Data**: 2026-08-25

## Contexto

O documento 02 usa Azure AI Content Safety com Prompt Shields para inspecao de
conteudo e defesa contra injecao de prompt. Sem Azure, e preciso resolver dois
problemas distintos que costumam ser confundidos:

1. **Redacao de PII** (LGPD, OWASP LLM02): impedir que CPF, cartao e conta
   bancaria saiam da plataforma ou sejam persistidos em claro.
2. **Deteccao de injecao de prompt** (OWASP LLM01).

O primeiro tem solucao boa e deterministica. O segundo, nao — e importante ser
honesto sobre isso.

## Decisao

Servico `aia-guardrails` em Python (a escolha da linguagem se justifica aqui: o
Presidio e Python), com:

- **Presidio** para deteccao de PII, com reconhecedores brasileiros proprios para
  **CPF, CNPJ e agencia/conta**. Cada um combina padrao com **validacao de digito
  verificador**: regex sozinho transforma numero de protocolo de 11 digitos em
  falso positivo, e um detector que apaga metade dos numeros do texto e desligado
  pelo time na primeira semana.
- **Detector alternativo por regex**, sem modelo de linguagem, usado quando o
  modelo do spaCy nao esta disponivel. Cobre CPF, CNPJ, cartao, email, telefone e
  IP; nao cobre nome de pessoa, e essa diferenca esta documentada.
- **Heuristicas de injecao deliberadamente conservadoras**, com limiar de
  bloqueio em 0,8.

**Politica de decisao**: PII gera REDACAO, nao bloqueio — recusar a requisicao
por conter um CPF puniria o usuario por um dado que a plataforma sabe tratar.
Injecao forte gera BLOQUEIO, porque nao existe versao segura do conteudo.

**Politica de falha**: se o guardrails nao responde, o conteudo SEGUE sem redacao
e o fato e registrado. Bloquear toda a inferencia por causa do guardrail
transformaria degradacao em indisponibilidade. O que a plataforma garante nesse
estado e nao PERSISTIR conteudo nao redigido.

## O que isto NAO resolve

Heuristica de injecao de prompt e defesa parcial, e dizer o contrario seria
perigoso. A protecao real vem em camadas, e todas continuam valendo: conteudo
recuperado e marcado como dado e nunca interpretado como instrucao, argumento de
tool e validado por schema, saida de modelo nunca e executada, tool de risco alto
exige aprovacao humana e o principio de menor privilegio vale por tool.

## Alternativas consideradas

| Alternativa                          | Por que nao                                                                                                             |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Llama Guard como unico guardrail     | Custa uma inferencia extra por requisicao e nao localiza a PII para redigir. Continua disponivel como adapter opcional. |
| Somente regex                        | Nao detecta nome de pessoa nem endereco.                                                                                |
| Servico gerenciado de content safety | Prende a plataforma a uma nuvem (ADR-012) e envia para fora justamente o conteudo que se quer proteger.                 |

## Revisao

Reavaliar as heuristicas de injecao a cada rodada de red team. Se a taxa de falso
positivo passar de 1% do trafego legitimo, afrouxar; se um ataque conhecido
passar, endurecer com evidencia.
