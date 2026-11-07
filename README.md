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

### Settings

Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.

## Status

Early development. Not for production use.
