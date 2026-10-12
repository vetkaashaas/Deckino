#!/usr/bin/env bash
# Backs up the production database and proves the backup restores.
#
#   1. pg_dump runs inside the Railway "Deckino Db" service over `railway ssh` (the database has no public
#      address, and gets none for this) and streams back as base64, so the terminal can't mangle the bytes.
#   2. The dump is saved to data/backups/ (git-ignored): an off-Railway copy, since wiping the Railway volume
#      would also delete Railway's own backups.
#   3. It is restored into a scratch database in the local deckino-postgres container, and the row count of every
#      table is compared with production. Any difference fails the script.
#
# Needs: the Railway CLI logged in with an SSH key registered (`railway ssh` sets that up), and the local
# PostgreSQL container from AGENTS.md. Run from Code/:  bash scripts/test-db-restore.sh
set -euo pipefail

service="Deckino Db"
scratch="deckino_restore_test"
stamp="$(date -u +%Y%m%d-%H%M%S)"
dump="data/backups/deckino-$stamp.dump"
mkdir -p data/backups

# ssh joins its arguments into one line for the remote shell, so the command goes as a single string.
remote() { railway ssh --service "$service" -- "$1" | tr -d '\r'; }
local_psql() { docker exec -i deckino-postgres psql -U deckino -v ON_ERROR_STOP=1 -Atq "$@"; }

# Exact counts of every table in the public schema, as "table|rows" lines, sorted.
count_sql="select string_agg(format('select %L || ''|'' || count(*) from %I', table_name, table_name), ' union all ' order by table_name) from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'"

echo "Dumping production ($service)..."
remote 'pg_dump -U "$PGUSER" -d "$PGDATABASE" -Fc --no-owner --no-privileges | base64' | base64 -d > "$dump"
echo "Saved $dump ($(du -h "$dump" | cut -f1))"

echo "Counting production rows..."
production_counts="$(remote "psql -U \"\$PGUSER\" -d \"\$PGDATABASE\" -Atq -c \"\$(psql -U \"\$PGUSER\" -d \"\$PGDATABASE\" -Atq -c \"$count_sql\")\"" | sort)"

echo "Restoring into $scratch..."
local_psql -d postgres -c "drop database if exists $scratch" -c "create database $scratch"
docker exec -i deckino-postgres pg_restore -U deckino -d "$scratch" --no-owner --no-privileges --exit-on-error < "$dump"
restored_counts="$(local_psql -d "$scratch" -c "$(local_psql -d "$scratch" -c "$count_sql")" | sort)"

# Rows written to production between the dump and the count (a sign-up, a price snapshot) would show as a
# difference; run it again if that happens.
if diff <(echo "$production_counts") <(echo "$restored_counts"); then
  echo "Restore OK: every table has the same row count as production."
  echo "$restored_counts" | column -t -s '|'
else
  echo "Restore FAILED: the row counts above differ (< production, > restored)." >&2
  exit 1
fi
