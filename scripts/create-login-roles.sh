#!/usr/bin/env bash
# Create (or rotate) the API and worker login roles on a real database,
# with long random passwords. Run once after the migrations, and again
# whenever the passwords must be changed.
#
# Usage:
#   ADMIN_DATABASE_URL='postgres://<admin user>@<host>:5432/<database>?sslmode=require' \
#     ./scripts/create-login-roles.sh
#
# ADMIN_DATABASE_URL must point at the target database (not "postgres"),
# using the admin account that ran the migrations. You are asked for its
# password by psql if the URL has none.
#
# What it does:
#   1. makes two random 40-character passwords on this machine,
#   2. hashes them here (SCRAM-SHA-256), so only the hashes are sent,
#   3. runs db/roles/login_roles.sql and db/roles/check_login_roles.sql in
#      one transaction: if a check fails, nothing is changed,
#   4. prints DATABASE_URL and WORKER_DATABASE_URL once.
# Nothing is written to disk. Store the two URLs in the secret manager
# straight away: they cannot be shown again (rerun to make new ones).
#
# Needs: psql 15 or newer, Node.js 18 or newer, openssl.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ADMIN_DATABASE_URL:?Set ADMIN_DATABASE_URL to the target database, as the admin account}"

for tool in psql node openssl; do
  command -v "$tool" >/dev/null || { echo "Missing $tool" >&2; exit 1; }
done
PSQL_MAJOR="$(psql --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
if (( PSQL_MAJOR < 15 )); then
  echo "psql $PSQL_MAJOR is too old: version 15 or newer is needed" >&2
  exit 1
fi

DB_NAME="$(node -e 'console.log(decodeURIComponent(new URL(process.argv[1]).pathname.slice(1)))' "$ADMIN_DATABASE_URL")"
if [[ -z "$DB_NAME" || "$DB_NAME" == "postgres" ]]; then
  echo "ADMIN_DATABASE_URL must name the application database, not '${DB_NAME:-nothing}'" >&2
  exit 1
fi

echo "This creates or rotates talos_api and talos_jobs on database '$DB_NAME'."
echo "Rotating breaks running servers until they get the new URLs."
read -r -p "Type the database name to continue: " CONFIRM
[[ "$CONFIRM" == "$DB_NAME" ]] || { echo "Stopped." >&2; exit 1; }

# URL-safe random passwords (letters, digits, - and _).
make_password() { openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-40; }
API_PASSWORD="$(make_password)"
JOBS_PASSWORD="$(make_password)"

TALOS_API_PASSWORD="$(printf '%s' "$API_PASSWORD" | node "$ROOT/scripts/scram-verifier.mjs")"
TALOS_JOBS_PASSWORD="$(printf '%s' "$JOBS_PASSWORD" | node "$ROOT/scripts/scram-verifier.mjs")"
export TALOS_API_PASSWORD TALOS_JOBS_PASSWORD

# One transaction: if any check fails, nothing changes (old passwords keep working).
if ! CHECK_OUTPUT="$(psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q --single-transaction \
       -f "$ROOT/db/roles/login_roles.sql" -f "$ROOT/db/roles/check_login_roles.sql" 2>&1)"; then
  unset TALOS_API_PASSWORD TALOS_JOBS_PASSWORD
  echo "$CHECK_OUTPUT" | grep -E 'ERROR|WARNING|FAILED' | sed -E 's/^psql:[^ ]+ //' >&2
  echo "Nothing was changed. Fix the problem above and run again." >&2
  exit 1
fi
unset TALOS_API_PASSWORD TALOS_JOBS_PASSWORD
echo "$CHECK_OUTPUT" | sed -n 's/.*NOTICE:  PASS/  PASS/p'

# Build the two connection URLs from the admin URL (same host, port, database, options).
make_url() {
  node -e 'const u = new URL(process.argv[1]); u.username = process.argv[2]; u.password = process.argv[3]; console.log(u.toString())' \
    "$ADMIN_DATABASE_URL" "$1" "$2"
}

cat <<EOF

Done. Save these two values in the secret manager now. They are not stored anywhere.

DATABASE_URL=$(make_url talos_api "$API_PASSWORD")
WORKER_DATABASE_URL=$(make_url talos_jobs "$JOBS_PASSWORD")

Never commit them, paste them in a chat, or put them in a ticket.
EOF
