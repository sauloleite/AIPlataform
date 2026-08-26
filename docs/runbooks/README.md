# Runbooks

Procedures for when something goes wrong. Each has a trigger, a diagnosis and an
action, in the order you will need them at 3 in the morning.

Rule: a runbook that has never been executed is not a runbook, it is a hope. Test
it in a game day before you need it.

| Runbook                                                       | Trigger                                          |
| ------------------------------------------------------------- | ------------------------------------------------ |
| [Degraded model provider](degraded-provider.md)               | A circuit open for more than 5 min               |
| [Redis unavailable](redis-unavailable.md)                     | A health alert or `budget_unverified` in traffic |
| [Queue above its limit](queue-above-limit.md)                 | Queue length growing                             |
| [Model deprecation](model-deprecation.md)                     | Alert 60 days ahead                              |
| [Suspected injection or exfiltration](suspected-injection.md) | A guardrails alert                               |
| [Secret rotation](secret-rotation.md)                         | A detected leak, or routine                      |
| [Data subject request (LGPD)](lgpd-data-subject-request.md)   | A request from the DPO                           |
| [Restore and DR test](restore-and-dr.md)                      | Quarterly, or on data loss                       |
