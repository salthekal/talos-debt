#!/usr/bin/env bash
# End-to-end run of the dashboard against the real API and a fresh dev database.
#
# Needs, already running:
#   - PostgreSQL with ADMIN_DATABASE_URL set (as for scripts/db-reset.sh)
#   - the API on :3000 with AUTH_MODE=session, MAIL_DRIVER=log, APP_URL=http://localhost:5173
#   - the dashboard on :5173 (cd web && npm run dev)
# and Python 3 with openpyxl (to build the Excel files), Chromium for Playwright.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
: "${ADMIN_DATABASE_URL:?Set ADMIN_DATABASE_URL}"

"$ROOT/scripts/db-reset.sh" >/dev/null
# Same address rule as scripts/db-reset.sh: the last path segment becomes talos_dev.
DB_URL="${ADMIN_DATABASE_URL%/*}/talos_dev"
if [[ "$ADMIN_DATABASE_URL" == *"?"* ]]; then
  DB_URL="${ADMIN_DATABASE_URL%%\?*}"; DB_URL="${DB_URL%/*}/talos_dev?${ADMIN_DATABASE_URL#*\?}"
fi
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$HERE/fixtures.sql"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
curl -sf -c "$WORK/c" -H 'content-type: application/json' -H 'x-talos: 1' \
  -d '{"email":"owner@demo.example","password":"talos-dev-password"}' http://localhost:3000/api/auth/login >/dev/null
curl -sf -b "$WORK/c" http://localhost:3000/api/imports/template -o "$WORK/template.xlsx"
python3 -I "$HERE/make-files.py" "$WORK/template.xlsx" "$WORK"

FILES="$WORK" node "$HERE/run.mjs"
