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
  - `BYPASSRLS` is not inherited through role membership, so the worker login role (`talos_jobs`) must be created with `BYPASSRLS` itself. `assertWorkerRole` refuses to start otherwise.
- The database already enforces these, so do not duplicate or fight them in code:
  - Approved payments recalculate `debts.amount_outstanding`; reaching zero marks the debt `paid` and cancels pending reminders.
  - A new open dispute marks the debt `disputed` and cancels pending reminders.
  - Changes to key tables are written to `audit.activity_log` automatically. The log cannot be edited or deleted.
  - A payment cannot leave `pending_approval` without a reviewer. A legal case cannot move past `ready` without approval.
- Dashboard numbers come from the views `app.v_debt_overview` and `app.v_client_totals`.

## Back end conventions (`/api`)

- Every query that touches client data goes through `withTenant(pool, ctx, fn)` in `api/src/db.ts`. It opens a transaction and sets `app.client_id`, `app.user_id` and `app.actor_type` with `set_config(..., true)`. Never query client tables outside it.
- The API connects as `talos_api` (member of `talos_app`). `assertRlsEnforced` stops the server from starting with a superuser or an RLS-bypassing role. Do not remove it.
- Login is a development placeholder (`AUTH_MODE=dev`, headers `x-client-id` and `x-user-id`), checked against `app.users` under RLS. It is refused in production.
- Role checks use `requireRole` in `api/src/auth.ts`. Viewers can only read.
- Money stays a string end to end (`pg` returns `numeric` as text). Never convert amounts to JavaScript numbers.
- Validate params, query and body with zod (`parseOr400`). Return 404, not 403, for another client's records, so their existence is not revealed.
- One `pg` connection runs one query at a time: inside `withTenant`, await queries one after another (no `Promise.all` on the same connection).
- Tests live in `api/test`, run against a fresh `talos_test` database, and must cover tenant isolation and anything touching money.
- WhatsApp sending goes through `sendReminder` in `api/src/whatsapp/outbound.ts`. It checks stop rules, working hours, the phone and the template, saves the message as `queued`, calls Meta outside any transaction, then saves `sent` or `failed`. Do not call Meta from inside `withTenant`.
- Outside production, every message is redirected to `WHATSAPP_DEV_REDIRECT_TO` and sending is refused without it. Never remove this; fake debtors' numbers must never receive anything. The dev overrides are refused in production.
- Meta is behind the `WhatsAppSender` interface; tests use a fake sender. Tests never call Meta.
- The AI is behind the `LlmClient` interface in `api/src/ai/llm.ts` (Gemini today); tests use a fake. Call it outside any transaction. Every reply passes `checkReply` in `api/src/agent/decision.ts` before sending; a failed check sends the safe fallback reply and flags the conversation for staff.
- `AI_FREE_TIER=true` is for fake data only and is refused in production.
- The webhook (`/webhooks/whatsapp`) checks Meta's signature with `WHATSAPP_APP_SECRET` and uses the worker connection only to find the sender and store raw events; everything else runs inside `withTenant` with `actor_type = 'ai'`.
- Each test file starts from a freshly reset `talos_test` database (`api/test/setup.ts`).

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
2. Back end skeleton with the per-request client setting (done: `api/`, run `npm run dev`, tests with `npm test`)
3. WhatsApp outbound template send (test number) (done: `api/src/whatsapp/`, `POST /api/debts/:id/send-reminder`, `npm run whatsapp:ping`)
4. WhatsApp inbound webhook, matched to the debtor (done: `api/src/routes/webhooks.ts`)
5. Agent reply grounded in the debtor's records, validated, sent and logged (done: `api/src/agent/`, `api/src/ai/llm.ts`)
6. Dashboard: debtor list, debtor timeline, payment and dispute approval queue, totals
7. Excel import with validation
8. Scheduler for automatic reminders
9. Receipt reading and promise capture
10. Najiz filing pack export

## Conventions

- Small pull requests, merged daily. One branch per person per feature, for example `sal/whatsapp-webhook`, `karam/add-unified-number`.
- Write tests for anything touching money, stop rules or tenant isolation.
- No em dashes in user-facing text. Simple words in Arabic and English.
