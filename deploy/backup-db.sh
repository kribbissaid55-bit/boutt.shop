#!/usr/bin/env bash
#
# One-shot SQLite backup using `.backup` (atomic, safe under concurrent writes).
# Compresses the copy, retains 14 days.
#
# Usage:
#   bash deploy/backup-db.sh
#
# Cron every hour:
#   0 * * * * cd /path/to/bsa && bash deploy/backup-db.sh >> logs/backup.log 2>&1
#
# Configure via env:
#   BACKUP_DIR — where to write backups (default ./backups)
#   DB_PATH    — path to the SQLite file (default ./server/prisma/dev.db)
#   RETENTION_DAYS — days to keep (default 14)

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
DB_PATH="${DB_PATH:-./server/prisma/dev.db}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

if [ ! -f "$DB_PATH" ]; then
  echo "✗ DB not found at $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "✗ sqlite3 CLI not installed" >&2
  exit 2
fi

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="$BACKUP_DIR/dev-$STAMP.db"

sqlite3 "$DB_PATH" ".backup '$DEST'"
gzip "$DEST"

# Retention: prune backups older than N days.
find "$BACKUP_DIR" -name 'dev-*.db.gz' -type f -mtime "+${RETENTION_DAYS}" -delete

echo "✓ backed up → $DEST.gz  (older than ${RETENTION_DAYS}d pruned)"
