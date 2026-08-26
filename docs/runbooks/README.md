# Runbooks

Procedimentos para quando algo dá errado. Cada um tem gatilho, diagnostico e
acao, na ordem em que voce vai precisar deles as 3 da manha.

Regra: um runbook que nunca foi executado nao e um runbook, e uma esperanca.
Teste em game day antes de precisar.

| Runbook                                                      | Gatilho                                           |
| ------------------------------------------------------------ | ------------------------------------------------- |
| [Provedor de modelo degradado](provedor-degradado.md)        | Circuito aberto por mais de 5 min                 |
| [Redis indisponivel](redis-indisponivel.md)                  | Alerta de saude ou `budget_unverified` no trafego |
| [Fila acima do limite](fila-acima-do-limite.md)              | Comprimento da fila crescendo                     |
| [Descontinuacao de modelo](descontinuacao-de-modelo.md)      | Alerta 60 dias antes                              |
| [Suspeita de injecao ou exfiltracao](suspeita-de-injecao.md) | Alerta do guardrails                              |
| [Rotacao de segredo](rotacao-de-segredo.md)                  | Vazamento detectado ou rotina                     |
| [Pedido de titular (LGPD)](pedido-de-titular-lgpd.md)        | Solicitacao do DPO                                |
| [Restauracao e teste de DR](restauracao-e-dr.md)             | Trimestral, ou perda de dados                     |
