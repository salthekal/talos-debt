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

1. Copy `.env.example` to `.env` and fill in the values.
2. Create a PostgreSQL 15+ database with the `vector` extension available.
3. Run `db/migrations/0001_initial_schema.sql`.

## Status

Early development. Not for production use.
