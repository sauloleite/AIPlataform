# Restauracao e teste de recuperacao

**Gatilho**: trimestral (teste), ou perda de dados (real).

Um backup nunca testado nao e um backup. Este runbook existe para ser executado
em dia calmo.

## O que precisa de backup, e o que nao precisa

| Componente   | Backup           | Por que                                                              |
| ------------ | ---------------- | -------------------------------------------------------------------- |
| MongoDB      | **Sim, critico** | Projetos, orcamentos, auditoria, outbox, chave de assinatura         |
| Redis        | Recomendado      | Contadores de orcamento. Perder significa reconciliar pela auditoria |
| MinIO        | **Sim**          | Documentos originais                                                 |
| Qdrant       | Nao              | Reconstruivel a partir dos documentos no MinIO                       |
| Ollama       | Nao              | Modelos sao rebaixaveis                                              |
| Grafana LGTM | Opcional         | Telemetria historica                                                 |

O Qdrant nao entrar no backup e uma decisao consciente: reindexar custa tempo de
CPU, guardar indice vetorial custa espaco e ainda pode ficar inconsistente com a
fonte.

## Backup

```bash
COMPOSE="docker compose -f deploy/compose/docker-compose.yml"
DATA=$(date +%Y%m%d)

$COMPOSE exec -T mongo mongodump --archive --gzip > "backup-mongo-${DATA}.gz"
$COMPOSE exec -T redis redis-cli SAVE
docker run --rm -v aia_minio-data:/data -v "$PWD:/backup" alpine \
  tar czf "/backup/backup-minio-${DATA}.tar.gz" -C /data .
```

Guarde fora do host. Um backup no mesmo disco nao sobrevive ao que costuma
destruir o disco.

## Restauracao

```bash
$COMPOSE down
$COMPOSE up -d mongo redis minio
$COMPOSE exec -T mongo mongorestore --archive --gzip --drop < backup-mongo-AAAAMMDD.gz
docker run --rm -v aia_minio-data:/data -v "$PWD:/backup" alpine \
  sh -c "rm -rf /data/* && tar xzf /backup/backup-minio-AAAAMMDD.tar.gz -C /data"
$COMPOSE up -d
```

## Validar a restauracao

Restaurar sem validar so adia a descoberta do problema:

```bash
make e2e
```

Verifique especificamente:

- [ ] Login funciona (a chave de assinatura veio junto)
- [ ] Projetos e orcamentos estao la
- [ ] A auditoria tem os registros anteriores ao backup
- [ ] Uma inferencia nova funciona ponta a ponta

## Registrar (teste trimestral)

- Horario de inicio e fim: **RTO real medido**
- Timestamp do backup usado versus momento da falha: **RPO real**
- O que falhou ou surpreendeu

Se o RTO medido nao atende o alvo, o plano precisa mudar — nao o alvo.
