#!/usr/bin/env bash
# Backup do A3K CMS: snapshot consistente do sqlite + tar do media/.
# Uso: /opt/a3k-cms/deploy/backup.sh   (via cron, ver setup.sh)
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/a3k-cms}"
DEST="${BACKUP_DIR:-/var/backups/a3k-cms}"
KEEP_DAYS="${KEEP_DAYS:-14}"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"

# .backup faz cópia consistente mesmo com o servidor escrevendo (WAL)
sqlite3 "$APP_DIR/data/cms.sqlite" ".backup '$DEST/cms-$TS.sqlite'"
gzip -f "$DEST/cms-$TS.sqlite"

tar -C "$APP_DIR" -czf "$DEST/media-$TS.tar.gz" media

find "$DEST" -type f -mtime "+$KEEP_DAYS" -delete

echo "$(date -Is) backup ok -> $DEST (cms-$TS.sqlite.gz, media-$TS.tar.gz)"
