#!/usr/bin/env bash
# OpsPilot database backup: compressed pg_dump custom-format archive + SHA-256 sidecar.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/opspilot tools/backup-db.sh [output-dir]
#
# Environment:
#   DATABASE_URL   (required) PostgreSQL connection URL for the source database.
#   BACKUP_DIR     Output directory (default: ./backups). Created if missing.
#   PG_DUMP_BIN    pg_dump binary (default: pg_dump). Point at a version >= the server
#                  major version, or a wrapper (e.g. `docker exec <pg-container> pg_dump`).
#
# Output: <BACKUP_DIR>/opspilot-<UTC timestamp>.dump plus opspilot-<UTC timestamp>.dump.sha256
# The sidecar uses the standard `sha256sum -c` format and is verified by restore-db.sh
# before any restore is attempted. Existing files are never overwritten.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "error: DATABASE_URL is required" >&2
  exit 2
fi

backup_dir="${1:-${BACKUP_DIR:-./backups}}"
pg_dump_bin="${PG_DUMP_BIN:-pg_dump}"
mkdir -p "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="$backup_dir/opspilot-$stamp.dump"
sidecar="$dump_file.sha256"

if [[ -e "$dump_file" || -e "$sidecar" ]]; then
  echo "error: $dump_file already exists; refusing to overwrite" >&2
  exit 1
fi

# -Fc: compressed custom format (random-access, restorable with pg_restore).
# -Z 6: compression level. --no-owner --no-privileges: portable across roles.
if ! "$pg_dump_bin" -Fc -Z 6 --no-owner --no-privileges -d "$DATABASE_URL" -f "$dump_file"; then
  rm -f "$dump_file"
  echo "error: pg_dump failed; partial archive removed" >&2
  exit 1
fi

# SHA-256 sidecar in sha256sum format so `sha256sum -c` works out of the box.
(cd "$backup_dir" && sha256sum "$(basename "$dump_file")" > "$(basename "$sidecar")")

echo "backup written: $dump_file"
echo "checksum:       $sidecar"
