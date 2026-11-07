#!/usr/bin/env bash
# Recreate the development database from scratch:
#   1. drop and create the database
#   2. run every migration in db/migrations in order
#   3. load the fake seed data (dev/seed.sql)
#   4. run the safety checks (dev/checks.sql)
#
# Usage:
#   ./scripts/db-reset.sh
#
# Connection: uses ADMIN_DATABASE_URL if set, otherwise the Docker
# default postgres://postgres:postgres@localhost:5432/postgres.
# DEVELOPMENT ONLY. Refuses to run against anything that is not local.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
DB_NAME="${DB_NAME:-talos_dev}"

case "$ADMIN_URL" in
  *localhost*|*127.0.0.1*|*"@/"*|*"host=/"*) ;;
  *) echo "Refusing to reset a non-local database: $ADMIN_URL" >&2; exit 1 ;;
esac

# Build the URL for the target database by replacing the last path segment.
DB_URL="${ADMIN_URL%/*}/${DB_NAME}"
if [[ "$ADMIN_URL" == *"?"* ]]; then
  DB_URL="${ADMIN_URL%%\?*}"; DB_URL="${DB_URL%/*}/${DB_NAME}?${ADMIN_URL#*\?}"
fi

echo "Resetting database '$DB_NAME'..."
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE \"$DB_NAME\""

echo "Running migrations..."
for f in "$ROOT"/db/migrations/*.sql; do
  echo "  $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "Loading fake seed data..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/dev/seed.sql"

echo "Running safety checks..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/dev/checks.sql" 2>&1 | sed -n 's/.*NOTICE:  /  /p; /All database checks passed/p'

echo "Done. Connect with: $DB_URL"
