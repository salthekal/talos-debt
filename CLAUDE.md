# CLAUDE.md

Guidance for Claude Code (and any AI assistant) working in this repository.

## What this project is

Talos Debt Follow-up: a system that helps Saudi companies follow up with people who owe them money (couriers, workers, customers) until they pay.

- A **WhatsApp agent** sends scheduled reminders, answers debtors' questions using only the client's own records, records promises to pay, and reads payment receipts.
- A **client dashboard and CRM** shows every debtor, debt, message, payment and legal step, and lets client staff approve payments and handle disputes.
- When a debtor does not respond, the system prepares a **filing pack** for an execution request on Najiz (Ministry of Justice). It never logs into Najiz itself; the client or its lawyer submits.

Interface languages: Arabic (right to left) and English. Debtor message languages: Arabic, English, Urdu, Bengali, Hindi.

## Repository layout and ownership

| Folder | Contents | Owner |
|---|---|---|
| `/db` | PostgreSQL schema and migrations | Karam |
| `/api` | Back end API and WhatsApp webhook | Sal |
| `/worker` | Scheduler that sends reminders and processes webhooks | Sal |
| `/web` | Client dashboard and CRM (React) | Sal |
| `/docs` | Schema diagram and documentation | Both |

**Rule:** only edit files in your own area. Schema changes go to `/db/migrations` as a new numbered file, through a pull request reviewed by Karam. Never edit an existing migration that has been applied.

## Tech stack

- TypeScript everywhere
- Back end: Node.js (Fastify), plain SQL through `pg` (node-postgres). The SQL schema in `/db` is the source of truth; do not let an ORM generate or change tables.
- Front end: React + Vite, bilingual with full right-to-left support
- Database: PostgreSQL 15+ with `pgvector`, `pgcrypto`, `citext`
- WhatsApp: Meta WhatsApp Cloud API (webhooks in, Graph API out)
- AI: provider and model set by environment variables, behind one small interface so the provider can be swapped

## Database rules (from `/db/migrations/0001_initial_schema.sql`)

- Three schemas: `app` (business data), `ai` (document chunks, AI usage log), `audit` (append-only activity log).
- Primary keys are UUIDs. Money is `numeric(12,2)` in SAR, never floats. Times are `timestamptz` (UTC stored, Asia/Riyadh shown).
- **Tenant isolation:** every tenant table has `client_id`, and Row Level Security filters by it. Every API request must run inside a transaction that starts with:
  ```sql
  SET LOCAL app.client_id = '<client uuid>';
  SET LOCAL app.user_id   = '<user uuid>';      -- omit for system actions
  SET LOCAL app.actor_type = 'user';            -- or 'system', 'ai'
  ```
- Database roles: `talos_app` (API, RLS applies) and `talos_worker` (scheduler and webhooks, bypasses RLS). Keep worker code small and careful.
- The database already enforces these, so do not duplicate or fight them in code:
  - Approved payments recalculate `debts.amount_outstanding`; reaching zero marks the debt `paid` and cancels pending reminders.
  - A new open dispute marks the debt `disputed` and cancels pending reminders.
  - Changes to key tables are written to `audit.activity_log` automatically. The log cannot be edited or deleted.
  - A payment cannot leave `pending_approval` without a reviewer. A legal case cannot move past `ready` without approval.
- Dashboard numbers come from the views `app.v_debt_overview` and `app.v_client_totals`.

## WhatsApp agent rules (must always hold)

1. **The AI never decides an amount.** Amounts, dates and references come from the database and are passed into the prompt. Validate every AI reply: any amount it mentions must match the record.
2. Answer only from the debtor's own records and the client's documents. If unsure, say a staff member will follow up, and flag it for a human.
3. A debtor saying the amount is wrong creates a dispute (which stops reminders). Do not argue.
4. No threats beyond stating, factually, that unpaid amounts may be referred for legal procedures. Never contact family or employers. Never mention other debtors.
5. Messages only inside the client's working hours and days (`app.follow_up_rules`).
6. WhatsApp 24-hour rule: free-form replies only within 24 hours of the debtor's last message; otherwise use an approved template.
7. Store every inbound webhook in `app.webhook_events` first (unique event id), then process. Meta retries, so processing must be safe to repeat.
8. Log every AI call in `ai.agent_runs` (model, tokens, cost, structured output).
9. Reply in the debtor's preferred language.

## Data and secrets

- **Never commit secrets.** Use `.env` (ignored by git); `.env.example` lists the variables.
- **Never commit real debtor or client data.** Development uses fake seed data only. Real data lives only in the Saudi-hosted production database.
- This repository is public: keep business plans, pricing and client names out of it.

## Development order (current plan)

1. Repository and dev database with the schema and fake seed data (done: `docker compose up -d` then `./scripts/db-reset.sh`)
2. Back end skeleton with the per-request client setting
3. WhatsApp outbound template send (test number)
4. WhatsApp inbound webhook, matched to the debtor
5. Agent reply grounded in the debtor's records, validated, sent and logged
6. Dashboard: debtor list, debtor timeline, payment and dispute approval queue, totals
7. Excel import with validation
8. Scheduler for automatic reminders
9. Receipt reading and promise capture
10. Najiz filing pack export

## Conventions

- Small pull requests, merged daily. One branch per person per feature, for example `sal/whatsapp-webhook`, `karam/add-unified-number`.
- Write tests for anything touching money, stop rules or tenant isolation.
- No em dashes in user-facing text. Simple words in Arabic and English.
