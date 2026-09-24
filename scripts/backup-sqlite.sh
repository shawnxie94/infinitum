#!/bin/sh
# SQLite 在线备份：用 sqlite3 .backup API 产出一致性快照（WAL 安全），并按保留天数清理旧备份。
# 用法: scripts/backup-sqlite.sh <db-path> <backup-dir> [retain-days]
#   例: scripts/backup-sqlite.sh /var/lib/infinitum/dev.db /var/backups/infinitum 14
# 建议由宿主机 cron/systemd timer 定时执行；恢复即停服务后用快照文件替换 db。
set -eu

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <db-path> <backup-dir> [retain-days=14]" >&2
  exit 1
fi

DB_PATH="$1"
BACKUP_DIR="$2"
RETAIN_DAYS="${3:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT="$BACKUP_DIR/db-$STAMP.sqlite"

mkdir -p "$BACKUP_DIR"

sqlite3 "$DB_PATH" ".backup '$OUTPUT'"

# 快照自校验：完整性检查失败视为备份失败，不留坏快照
if ! sqlite3 "$OUTPUT" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "backup integrity check failed: $OUTPUT" >&2
  rm -f "$OUTPUT"
  exit 1
fi

find "$BACKUP_DIR" -name 'db-*.sqlite' -type f -mtime +"$RETAIN_DAYS" -delete

echo "backup written: $OUTPUT"
