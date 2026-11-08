#!/usr/bin/env bash
# Recreate the development database from scratch:
#   1. drop and create the database
#   2. create the group roles (db/roles/group_roles.sql)
#   3. run every migration in db/migrations in order
#   4. create the login roles with development passwords (db/roles/login_roles.sql)
#      and check them (db/roles/check_login_roles.sql)
#   5. load the fake seed data (dev/seed.sql)
#   6. run the safety checks (dev/checks.sql)
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

echo "Creating group roles (before the migrations, as on a managed database)..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/roles/group_roles.sql"

echo "Running migrations..."
for f in "$ROOT"/db/migrations/*.sql; do
  echo "  $(basename "$f")"
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "Creating development login roles..."
# Same file as production, with fixed public development passwords.
TALOS_API_PASSWORD=talos_api_dev TALOS_JOBS_PASSWORD=talos_jobs_dev \
  psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/roles/login_roles.sql"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/db/roles/check_login_roles.sql" 2>&1 | sed -n 's/.*NOTICE:  /  /p'

echo "Loading fake seed data..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/dev/seed.sql"

echo "Running safety checks..."
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$ROOT/dev/checks.sql" 2>&1 | sed -n 's/.*NOTICE:  /  /p; /All database checks passed/p'

echo "Done. Connect with: $DB_URL"
