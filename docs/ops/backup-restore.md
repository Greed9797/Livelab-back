# Backup & Restore Strategy — LiveLab

## Visão Geral da Estratégia

LiveLab utiliza **backup automático em S3** (AWS ou Cloudflare R2) com retenção de 30 dias, complementado por **snapshots gerenciados do Supabase**. Em caso de desastre, há múltiplas opções de restauração com diferentes RTOs (Recovery Time Objective).

---

## 1. Estratégia de Backup (Automática)

### 1.1 Backup Automático via Cron (Backend)

**Trigger:** Job agendado no backend (disparado a cada X horas)

**Localização no código:** PLACEHOLDER — procurar em `src/jobs/` ou `src/cron/`

**Configuração:**
```bash
# Backend .env (ou Railway secrets)
BACKUP_S3_BUCKET=liveshop-prod-backups
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ACCESS_KEY=AKIA...
BACKUP_S3_SECRET_KEY=...
BACKUP_S3_ENDPOINT=  # Cloudflare R2 (opcional)
BACKUP_RETENTION_DAYS=30
```

**O que é feito:**
1. `pg_dump` do banco PostgreSQL via `DATABASE_URL`
2. Compressão (gzip)
3. Upload para S3 com naming: `liveshop-prod-backups/postgresql-{TIMESTAMP}.sql.gz`
4. Cleanup automático: arquivos > 30 dias são deletados

**Frequência:** PLACEHOLDER (recomendado: diário às 2:00 AM UTC)

**Monitoramento:**
```bash
# Verificar últimos backups em S3
aws s3 ls s3://liveshop-prod-backups/ --recursive \
  --profile default --region us-east-1

# Expected output:
# 2026-05-18 02:15:23   1234567 postgresql-2026-05-18T02-15-23Z.sql.gz
# 2026-05-17 02:10:11   1234567 postgresql-2026-05-17T02-10-11Z.sql.gz
```

### 1.2 Snapshots Supabase (Automático)

**Localização:** Painel Supabase → Database → Backups

**Configuração padrão:**
- Retenção: 7 dias (pode ser aumentada para 30 com plano Pro/Enterprise)
- Frequência: Diária (automática)

**Acesso:** https://app.supabase.com → Seu projeto → Database → Backups

### 1.3 Backup de Arquivos (Supabase Storage)

Se usando Supabase Storage para uploads:
- Arquivos são replicados automaticamente em buckets redundantes
- Versioning pode ser habilitado per-bucket: https://supabase.com/docs/guides/storage/managing-uploads#object-versioning
- Backup via: S3 replication ou Cloudflare R2 sync

---

## 2. Como Fazer Backup Manual

### 2.1 Backup Manual via pg_dump

**Situação:** Antes de migration crítica ou hotfix de segurança

```bash
# Variáveis
DATABASE_URL="postgresql://user:pass@db.xyz.supabase.co:5432/postgres"
BACKUP_FILE="liveshop-manual-$(date +%Y%m%d-%H%M%S).sql"

# Executar dump
pg_dump "$DATABASE_URL" --no-password --format=plain > "$BACKUP_FILE"

# Comprimir
gzip "$BACKUP_FILE"

# Upload pra S3 (se quiser arquivar)
aws s3 cp "${BACKUP_FILE}.gz" s3://liveshop-prod-backups/manual/ \
  --profile default --region us-east-1

echo "Backup criado: ${BACKUP_FILE}.gz"
```

**RTO:** ~5-10 minutos (depende do tamanho do DB)

### 2.2 Snapshot Manual via Supabase

1. Acessar https://app.supabase.com → Seu projeto
2. Database → Backups tab
3. Clicar "Create manual backup"
4. Nomear com contexto: "pre-migration-mkt-live-20260518"
5. Clicar "Create"
6. Aguardar conclusão (2-5 minutos)

**RTO:** ~2-5 minutos

### 2.3 Backup Incremental via WAL (Supabase)

Supabase automaticamente mantém WAL (Write-Ahead Logs) para replication point-in-time:
- Permite restaurar até um timestamp específico (últimos 7 dias)
- Habilitado por padrão em planos Pro/Enterprise

---

## 3. Como Restaurar

### 3.1 Restaurar via Supabase Snapshot (Recomendado)

**Cenário:** Database corrupto ou erro de dados

1. Acessar https://app.supabase.com → Seu projeto → Database → Backups
2. Selecionar snapshot a restaurar
3. Clicar "Restore from backup"
4. Confirmar (isso cria um **novo database** ou sobrescreve com downtime)
5. Aguardar 5-15 minutos
6. Testar conexão & validar dados

**Desvantagem:** Requer downtime ou switch de `DATABASE_URL`

**Alternativa zero-downtime:**
- Restaurar em novo database isolado
- Testar dados
- Switch `DATABASE_URL` em Railway (1-2 min downtime)

### 3.2 Restaurar via pg_restore (S3)

**Cenário:** Restauração granular ou sandbox testing

```bash
# 1. Baixar backup do S3
BACKUP_FILE="postgresql-2026-05-17T02-10-11Z.sql.gz"
aws s3 cp "s3://liveshop-prod-backups/${BACKUP_FILE}" . \
  --profile default --region us-east-1

gunzip "$BACKUP_FILE"

# 2. Restaurar em database local (testing)
# Option A: Restaurar tudo
RESTORE_DB="liveshop_restore_test"
createdb "$RESTORE_DB"
psql "$RESTORE_DB" < "${BACKUP_FILE%.gz}"

# Option B: Restaurar selecionando schema/table
pg_restore --dbname="postgresql://user:pass@host:5432/db" \
  --data-only \
  --table='public.clientes' \
  "${BACKUP_FILE%.gz}"

# 3. Validar integridade
psql "$RESTORE_DB" -c "SELECT COUNT(*) FROM clientes;"
```

**RTO:** 5-30 minutos (depende de tamanho & network)

### 3.3 Restaurar em Ponto No Tempo (PITR)

**Supabase com WAL (Pro/Enterprise):**

```bash
# Via Supabase API (docs: https://supabase.com/docs/guides/database/backups)
# Requer Token supabase-admin

# 1. Listar backups
curl -X GET \
  'https://api.supabase.com/v1/projects/{PROJECT_ID}/backups' \
  -H 'Authorization: Bearer {SUPABASE_TOKEN}'

# 2. Trigger restore com timestamp específico
curl -X POST \
  'https://api.supabase.com/v1/projects/{PROJECT_ID}/restore' \
  -H 'Authorization: Bearer {SUPABASE_TOKEN}' \
  -H 'Content-Type: application/json' \
  -d '{
    "backup_id": "...",
    "restore_point_in_time": "2026-05-17T08:30:00Z"
  }'

# 3. Monitorar status via https://app.supabase.com → Database → Backups
```

**RTO:** 10-20 minutos

---

## 4. Onde Estão os Backups

| Tipo | Localização | Acesso | Retenção |
|------|---|---|---|
| S3 Automático | s3://liveshop-prod-backups/postgresql-*.sql.gz | AWS Console ou CLI | 30 dias |
| S3 Manual | s3://liveshop-prod-backups/manual/ | AWS Console ou CLI | Indefinido (deletar manualmente) |
| Supabase Snapshot | Supabase → Database → Backups | https://app.supabase.com | 7 dias (30 com Pro) |
| WAL (PITR) | Supabase internal storage | Supabase API | 7 dias (30 com Pro) |
| Firebase Hosting | Firebase Console | https://console.firebase.google.com | Versionado (últimas 100) |

### 4.1 Listar Backups S3

```bash
# Último backup
aws s3 ls s3://liveshop-prod-backups/ \
  --recursive --region us-east-1 | tail -5

# Filtrar por data
aws s3 ls s3://liveshop-prod-backups/ \
  --region us-east-1 | grep "2026-05"
```

### 4.2 Testar Acesso a Backup

```bash
# Validar que você consegue ler do bucket
aws s3 cp s3://liveshop-prod-backups/postgresql-2026-05-17T02-10-11Z.sql.gz \
  ./test-download.sql.gz \
  --dryrun --region us-east-1
# Output: (dryrun) download s3://...

# Remover --dryrun pra fazer download real
```

---

## 5. Checklist Antes de Migrations Críticas

### Pré-Migration (24h antes)

- [ ] Confirmar último backup S3 foi executado com sucesso
  ```bash
  aws s3 ls s3://liveshop-prod-backups/ --region us-east-1 | tail -1
  ```
- [ ] Criar snapshot manual via Supabase
  ```
  https://app.supabase.com → Database → Backups → "Create manual backup"
  ```
- [ ] Testar restauração em sandbox (pra validar backup funciona)
  ```bash
  aws s3 cp s3://liveshop-prod-backups/LATEST.sql.gz ./test.sql.gz
  gunzip test.sql.gz
  psql test_db < test.sql
  ```
- [ ] Comunicar ao time que backup foi criado (Slack #deploys)
- [ ] Documentar migration no git commit message (referência backup)

### Durante Migration

- [ ] Manter Railway/Render logs abertos (`railway logs --follow`)
- [ ] Monitorar métricas de CPU/memória durante migration
- [ ] Se erro: PARAR, NÃO CONTINUAR
  ```bash
  # Via Railway: cancel deployment
  # Restaurar última snapshot em Supabase (2-5 min)
  ```

### Pós-Migration

- [ ] Validar integridade dados (queries críticas)
  ```bash
  psql $DATABASE_URL -c "SELECT COUNT(*) FROM clientes;"
  ```
- [ ] Executar testes automáticos em produção
- [ ] Monitorar Sentry por novos erros (1h)

---

## 6. Procedimento de Desastre (RTO < 15 min)

**Situação:** Banco de dados corrompido, incapaz de iniciar

### Passo 1: Validar Diagnóstico (1-2 min)
```bash
# Tentar conectar
psql $DATABASE_URL -c "SELECT 1;"

# Se erro: proceed to step 2
```

### Passo 2: Iniciar Restore (2 min)
```bash
# Option A: Via Supabase (mais rápido)
# 1. Acessar https://app.supabase.com → Database → Backups
# 2. Clicar restore em snapshot recente
# 3. Confirmar

# Option B: Via CLI (se API)
curl -X POST 'https://api.supabase.com/v1/projects/{PROJECT_ID}/restore' \
  -H 'Authorization: Bearer {TOKEN}' \
  -H 'Content-Type: application/json' \
  -d '{"backup_id": "...", "restore_point_in_time": "..."}'
```

### Passo 3: Aguardar Restore (5-15 min)
- Acompanhar em Supabase dashboard
- Logs: https://app.supabase.com → Database → Backups

### Passo 4: Validar & Switch (2 min)
```bash
# Conectar novo database
psql postgresql://user:pass@NEW_HOST:5432/postgres \
  -c "SELECT COUNT(*) FROM clientes;"

# Se OK: atualizar DATABASE_URL em Railway
# Railway: Secrets → DATABASE_URL → update → deploy
# Redeploy automático: ~1 min
```

### Passo 5: Comunicação (1 min)
- [ ] Postar em #incident Slack
- [ ] Mencionar: backup usado, timestamp, status
- [ ] Agendar retrospectiva 24h depois

**Total RTO:** ~15-25 minutos

---

## 7. Testes de Restauração (Recomendado: Mensal)

**Objetivo:** Validar que backups realmente funcionam

### Test Plan
```bash
# 1. Escolher backup aleatório
BACKUP=$(aws s3 ls s3://liveshop-prod-backups/ --region us-east-1 \
  | grep postgresql | tail -1 | awk '{print $4}')

# 2. Download em ambiente de test
aws s3 cp "s3://liveshop-prod-backups/${BACKUP}" ./test.sql.gz

# 3. Restaurar em database local
gunzip test.sql.gz
createdb liveshop_backup_test
psql liveshop_backup_test < test.sql

# 4. Validar integridade
psql liveshop_backup_test << EOF
SELECT COUNT(*) FROM clientes;
SELECT COUNT(*) FROM cabines;
SELECT COUNT(*) FROM live_sessions;
SELECT MAX(created_at) FROM audit_logs;
EOF

# 5. Cleanup
dropdb liveshop_backup_test

# 6. Documentar
echo "$(date): Backup restore test PASSED - ${BACKUP}" >> /var/log/backup-tests.log
```

### Automação (Cron)
```bash
# Adicionar ao crontab (Linux/Mac)
0 1 1 * * /home/devops/scripts/backup-restore-test.sh
# Executa: primeiro dia de cada mês às 1:00 AM
```

---

## 8. Monitoramento & Alertas

### Métricas a Monitorar

| Métrica | Alerta | Ação |
|---------|--------|------|
| Backup S3 não criado > 24h | WARNING | Verificar job, logs, permissions |
| Backup tamanho < 1MB | CRITICAL | Database está vazio?? |
| S3 costs > 2x normal | WARNING | Retenção muito alta? Cleanup? |
| Supabase snapshot count = 0 | CRITICAL | Backups não estão rodando |

### Setup de Alertas (AWS CloudWatch)

```bash
# Monitor S3 object count
aws cloudwatch put-metric-alarm \
  --alarm-name 'liveshop-backup-missing-24h' \
  --alarm-description 'Alert if no backup in last 24h' \
  --metric-name ObjectCount \
  --namespace AWS/S3 \
  --statistic Maximum \
  --period 86400 \
  --threshold 0 \
  --comparison-operator LessThanOrEqualToThreshold
```

### Notificação (SNS/Email)
```bash
# Config SNS topic pra alertar ops team
aws sns subscribe \
  --topic-arn arn:aws:sns:us-east-1:ACCOUNT:backup-alerts \
  --protocol email \
  --notification-endpoint devops@grupolivelab.com.br
```

---

## 9. Checklist de Implementação (Para Setup Inicial)

- [ ] S3 bucket criado: `liveshop-prod-backups`
- [ ] AWS IAM policy: backend tem permissions ListBucket + GetObject + PutObject
- [ ] Backend env vars setados: `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, etc.
- [ ] Cron job rodando (validar job logs)
- [ ] Supabase backups habilitado (console)
- [ ] Primeiro backup manual criado & testado
- [ ] Runbook compartilhado com ops team
- [ ] Alertas configurados (CloudWatch / PagerDuty)
- [ ] Teste de restauração agendado (mensal)

---

## 10. Referências

- [Supabase Backups](https://supabase.com/docs/guides/database/backups)
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [AWS S3 CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-services-s3.html)
- [Point-in-Time Recovery (PITR)](https://en.wikipedia.org/wiki/Point-in-time_recovery)
