#!/usr/bin/env bash
# OpsPilot database restore: verifies the SHA-256 sidecar, validates the archive, then
# restores a backup created by tools/backup-db.sh into a target database.
#
# Usage:
#   tools/restore-db.sh <backup.dump> [--target-url postgres://.../targetdb] [--clean]
#
# Environment:
#   DATABASE_URL       Target database when --target-url is not given. Required.
#   PG_RESTORE_BIN     pg_restore binary (default: pg_restore; same override notes as
#                      PG_DUMP_BIN in backup-db.sh).
#
# Safety rules (all enforced, no bypass flags):
#   1. The .sha256 sidecar must exist next to the archive and `sha256sum -c` must pass.
#      A tampered or corrupt archive is rejected before any target is touched.
#   2. `pg_restore --list` must parse the archive (custom-format integrity check).
#   3. Without --clean the target database must be empty (no user tables), so a restore
#      never silently mixes with live data. --clean drops and recreates objects first and
#      is meant for rehearsals on disposable databases only.
#
# After restoring, run a restore drill verification, e.g.:
#   bun run tools/validate-backup-restore.ts compare "$SOURCE_URL" "$TARGET_URL"
set -euo pipefail

dump_file="${1:-}"
target_url=""
clean=0
if [[ -z "$dump_file" || "$dump_file" == -* ]]; then
  echo "usage: $0 <backup.dump> [--target-url URL] [--clean]" >&2
  exit 2
fi
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-url) target_url="${2:?--target-url requires a value}"; shift 2 ;;
    --clean) clean=1; shift ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done
target_url="${target_url:-${DATABASE_URL:-}}"
if [[ -z "$target_url" ]]; then
  echo "error: target database required (DATABASE_URL or --target-url)" >&2
  exit 2
fi
if [[ ! -f "$dump_file" ]]; then
  echo "error: archive not found: $dump_file" >&2
  exit 2
fi

pg_restore_bin="${PG_RESTORE_BIN:-pg_restore}"
psql_bin="${PSQL_BIN:-psql}"
dir="$(cd "$(dirname "$dump_file")" && pwd)"
base="$(basename "$dump_file")"
sidecar="$dump_file.sha256"

# 1. Checksum sidecar verification (mandatory).
if [[ ! -f "$sidecar" ]]; then
  echo "error: missing checksum sidecar: $sidecar" >&2
  exit 1
fi
if ! (cd "$dir" && sha256sum -c "$base.sha256" >/dev/null); then
  echo "error: SHA-256 checksum mismatch for $base; archive is corrupt or tampered, refusing to restore" >&2
  exit 1
fi
echo "checksum verified: $base"

# 2. Archive structural validation.
if ! "$pg_restore_bin" --list "$dump_file" >/dev/null 2>&1; then
  echo "error: pg_restore cannot parse $base; archive is corrupt, refusing to restore" >&2
  exit 1
fi
echo "archive structure OK: $base"

# 3. Target must be empty unless --clean was explicitly requested.
if [[ "$clean" -eq 0 ]]; then
  count="$("$psql_bin" "$target_url" -tAXc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
  if [[ "$count" != "0" ]]; then
    echo "error: target database is not empty ($count tables present); use a fresh database or pass --clean for a disposable rehearsal" >&2
    exit 1
  fi
fi

# Server major version, used to recognize the one known cross-version pg_dump artifact:
# pg_dump >= 17 embeds `SET transaction_timeout = 0;` in every archive, and PostgreSQL
# servers < 17 reject that GUC (pg_restore then exits 1 although the restore completed).
server_version_num="$("$psql_bin" "$target_url" -tAXc "SHOW server_version_num")"
server_major=$((server_version_num / 10000))

restore_flags=(--no-owner --no-privileges)
if [[ "$clean" -eq 1 ]]; then
  restore_flags+=(--clean --if-exists)
  echo "warning: --clean drops existing objects in the target database" >&2
fi

restore_log="$(mktemp)"
if ! "$pg_restore_bin" -Fc "${restore_flags[@]}" -d "$target_url" "$dump_file" 2> "$restore_log"; then
  # Tolerate ONLY the pre-17 `transaction_timeout` error described above, and only
  # against a pre-17 server; every other pg_restore error still fails the restore.
  tolerated=0
  if [[ "$server_major" -lt 17 ]]; then
    remaining="$(grep -vE '^pg_restore: error: .*unrecognized configuration parameter "transaction_timeout"$|^Command was: SET transaction_timeout = 0;$|^pg_restore: warning: errors ignored on restore: [0-9]+$|^$' "$restore_log" || true)"
    if [[ -z "$remaining" ]]; then
      tolerated=1
    fi
  fi
  if [[ "$tolerated" -ne 1 ]]; then
    cat "$restore_log" >&2
    rm -f "$restore_log"
    echo "error: pg_restore failed" >&2
    exit 1
  fi
  echo "warning: pg_restore reported only the pre-17-incompatible 'SET transaction_timeout = 0' (ignored); restore completed" >&2
fi
rm -f "$restore_log"
echo "restore complete into $target_url"
