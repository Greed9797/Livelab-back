#!/usr/bin/env bash
# Custom pg_dump archive, gzip-wrapped for compatibility with existing backups.
# Retention belongs to an explicitly configured bucket lifecycle, never this job.
set -euo pipefail
umask 077

for name in DATABASE_URL BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY; do
  if [[ -z "${!name:-}" ]]; then
    echo "[backup] missing configuration: $name" >&2
    exit 2
  fi
done
for executable in node pg_dump pg_restore gzip aws; do
  command -v "$executable" >/dev/null || { echo "[backup] missing executable: $executable" >&2; exit 2; }
done

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/livelab-backup.XXXXXXXX")
trap 'rm -rf -- "$WORK_DIR"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
STAMP=$(date -u +%Y-%m-%d-%H%M%S)
BACKUP_ID=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')
FILE="liveshop-${STAMP}-${BACKUP_ID}.dump.gz"

export AWS_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY"
export AWS_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_KEY"
export AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}"
ENDPOINT=()
if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then ENDPOINT=(--endpoint-url "$BACKUP_S3_ENDPOINT"); fi

# No credentials in argv; stderr stays in a private temporary file and is removed.
if ! node "$SCRIPT_DIR/pg_connection_env.mjs" pg_dump --format=custom --no-owner \
    --quote-all-identifiers --lock-wait-timeout=15000 --file="$WORK_DIR/database.dump" 2>"$WORK_DIR/error.log"; then
  echo '[backup] dump failed; no upload attempted' >&2; exit 1
fi
if ! pg_restore --list "$WORK_DIR/database.dump" >"$WORK_DIR/archive.list" 2>"$WORK_DIR/error.log"; then
  echo '[backup] invalid archive; no upload attempted' >&2; exit 1
fi
gzip -c "$WORK_DIR/database.dump" >"$WORK_DIR/$FILE"
if ! aws "${ENDPOINT[@]}" s3 cp "$WORK_DIR/$FILE" "s3://$BACKUP_S3_BUCKET/postgres/$FILE" \
    --only-show-errors >"$WORK_DIR/upload.log" 2>&1; then
  echo '[backup] upload failed' >&2; exit 1
fi
echo "[backup] upload completed: $FILE (archive readable; restore not yet verified)"
