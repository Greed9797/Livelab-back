#!/usr/bin/env bash
# Backup offsite diário do Supabase Postgres → S3/R2.
#
# Uso (cron Railway 03:00 BRT):
#   bash scripts/pg_dump_offsite.sh
#
# Pré-requisitos (Railway env):
#   DATABASE_URL              — connection string Supabase
#   BACKUP_S3_BUCKET          — ex: livelab-backups
#   BACKUP_S3_ACCESS_KEY      — AWS / R2 access key
#   BACKUP_S3_SECRET_KEY      — secret
#   BACKUP_S3_ENDPOINT        — opcional, ex: https://<accountid>.r2.cloudflarestorage.com (para R2)
#   BACKUP_RETENTION_DAYS     — default 30
#
# Saída: arquivo `liveshop-YYYY-MM-DD-HHMM.dump.gz` em s3://$BUCKET/postgres/
#
# Restore:
#   aws s3 cp s3://$BUCKET/postgres/liveshop-2026-05-08-0300.dump.gz - | gunzip | pg_restore -d "$NEW_DATABASE_URL"
#
# Validação semanal recomendada:
#   - Domingo: pegar último dump, restaurar em DB temp Supabase
#   - Verificar SELECT count(*) FROM tenants
#   - Drop DB temp

set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[backup] ERRO: DATABASE_URL não setado" >&2
  exit 1
fi
if [ -z "${BACKUP_S3_BUCKET:-}" ]; then
  echo "[backup] ERRO: BACKUP_S3_BUCKET não setado" >&2
  exit 1
fi

TIMESTAMP=$(date -u +%Y-%m-%d-%H%M)
DUMP_FILE="liveshop-${TIMESTAMP}.dump.gz"
TMP_PATH="/tmp/${DUMP_FILE}"

echo "[backup] iniciando dump em $TIMESTAMP UTC"

# pg_dump custom format (-Fc) + gzip — compressível, restora seletivo possível
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --quote-all-identifiers \
  | gzip -9 > "$TMP_PATH"

DUMP_SIZE=$(du -h "$TMP_PATH" | cut -f1)
echo "[backup] dump local OK ($DUMP_SIZE)"

# Configurar AWS CLI / mc com creds + endpoint (R2 ou S3)
export AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY:?missing}"
export AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_KEY:?missing}"

S3_ENDPOINT_OPT=""
if [ -n "${BACKUP_S3_ENDPOINT:-}" ]; then
  S3_ENDPOINT_OPT="--endpoint-url=$BACKUP_S3_ENDPOINT"
fi

S3_KEY="postgres/${DUMP_FILE}"
aws s3 cp $S3_ENDPOINT_OPT "$TMP_PATH" "s3://${BACKUP_S3_BUCKET}/${S3_KEY}"
echo "[backup] upload OK → s3://${BACKUP_S3_BUCKET}/${S3_KEY}"

rm -f "$TMP_PATH"

# Retention: deletar dumps mais velhos que N dias
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
echo "[backup] aplicando retention ${RETENTION_DAYS}d"

CUTOFF=$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null \
       || date -u -v-${RETENTION_DAYS}d +%Y-%m-%d)

aws s3 ls $S3_ENDPOINT_OPT "s3://${BACKUP_S3_BUCKET}/postgres/" \
  | awk '{print $4}' \
  | grep -E '^liveshop-[0-9]{4}-[0-9]{2}-[0-9]{2}-' \
  | while read -r FILE; do
      FILE_DATE=$(echo "$FILE" | sed 's/liveshop-\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\).*/\1/')
      if [[ "$FILE_DATE" < "$CUTOFF" ]]; then
        aws s3 rm $S3_ENDPOINT_OPT "s3://${BACKUP_S3_BUCKET}/postgres/${FILE}"
        echo "[backup] deletado (>$RETENTION_DAYS dias): $FILE"
      fi
    done

echo "[backup] concluído"
