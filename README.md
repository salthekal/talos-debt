# Talos Debt Follow-up

A WhatsApp agent and client dashboard that help Saudi companies follow up on overdue debts, verify payments, and prepare execution files for Najiz.

Built by [Talos AI Solutions](https://talosksa.com), Jeddah.

## Structure

- `db/` PostgreSQL schema and migrations
- `api/` back end API and WhatsApp webhook
- `worker/` scheduler and background jobs
- `web/` client dashboard and CRM
- `docs/` documentation and schema diagram

See `CLAUDE.md` for architecture, rules and the development plan.

## Getting started

### Development database

You need Docker and the `psql` command line tool.

```bash
docker compose up -d          # start PostgreSQL 16 with pgvector
./scripts/db-reset.sh         # create the database, run migrations, load fake data, run checks
```

This gives you a database called `talos_dev` at
`postgres://postgres:postgres@localhost:5432/talos_dev` with:

- one fake client (a delivery company) and two users (owner and staff)
- five fake debtors, each in a different situation: heading to legal, promised to pay,
  receipt waiting for approval, disputing the amount, and partly paid
- Talos default WhatsApp templates in Arabic and English

Run `./scripts/db-reset.sh` again at any time to start fresh. It only works on local databases.

### Safety checks

`dev/checks.sql` proves the database rules hold: clients cannot see or write each other's data,
payments need a reviewer, paid and disputed debts stop their reminders, every change is logged and
the log cannot be edited, and legal cases need approval. The same checks run automatically on every
pull request (see `.github/workflows/db-checks.yml`).

### Back end API

```bash
cd api
cp .env.example .env          # local settings; never commit .env
npm install
npm run dev                   # starts on http://localhost:3000
npm test                      # resets a separate talos_test database and runs the tests
```

During development, log in by sending two headers with every request (the demo staff user):

```
x-client-id: 11111111-1111-4111-8111-111111111111
x-user-id:   22222222-2222-4222-8222-000000000002
```

| Method | Path | What it returns |
|---|---|---|
| GET | `/health` | Server and database status (no login) |
| GET | `/api/me` | Logged-in user and client |
| GET | `/api/dashboard/totals` | Main dashboard numbers |
| GET | `/api/debts?status=&search=&limit=&offset=` | Debt list for the CRM |
| GET | `/api/debtors/:id` | One debtor: phones, debts and full timeline |
| GET | `/api/approvals` | Payments waiting for review and open disputes |
| POST | `/api/payments/:id/approve` | Approve a payment (owner, admin, staff) |
| POST | `/api/payments/:id/reject` | Reject a payment with `{ "reason": "..." }` |
| POST | `/api/debts/:id/send-reminder` | Send a reminder now, with `{ "purpose": "follow_up" }` (owner, admin, staff) |

Money is returned as text (for example `"1280.50"`) so it is never rounded.

### Sending WhatsApp messages in development

1. In `api/.env`, fill in `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` (from Meta, WhatsApp, API Setup)
   and set `WHATSAPP_DEV_REDIRECT_TO` to your own number (added as a test recipient in Meta).
2. Check the connection: `npm run whatsapp:ping` sends Meta's `hello_world` to your phone.
3. Send through the full system (server running with `npm run dev`):

   ```bash
   curl -X POST http://localhost:3000/api/debts/66666666-6666-4666-8666-000000000002/send-reminder \
     -H 'x-client-id: 11111111-1111-4111-8111-111111111111' \
     -H 'x-user-id: 22222222-2222-4222-8222-000000000002' \
     -H 'content-type: application/json' -d '{"purpose":"follow_up"}'
   ```

Safety in development: every message goes to `WHATSAPP_DEV_REDIRECT_TO`, never to a debtor, and the
server refuses to send if it is not set. Reminders are only sent within the client's working hours
and days, never for paid, disputed, paused or legal debts, and never to wrong or opted-out numbers.
Until your own templates are approved in Meta, `WHATSAPP_DEV_TEMPLATE=hello_world:en_US` sends
Meta's test template instead.

### Settings

Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.

## Status

Early development. Not for production use.
