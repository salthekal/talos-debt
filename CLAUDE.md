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
| `/api/src/intake`, `/api/src/import`, `/api/src/storage` and their routes (`debtors`, `imports`, `documents`, `enforceability`) | Getting data in (Phase 3): manual entry, Excel import, file storage, enforceability | Karam (agreed with Sal) |
| `/api/src/scheduler` | Scheduler that sends reminders, checks promises and marks debts ready for legal (runs as its own process: `npm run scheduler`). It lives in `/api` to share its database, WhatsApp and stop-rule code | Sal |
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

## Database rules (`/db/migrations`)

The migrations, in order. Each one is applied once and never edited after it has run on a real database.

| File | What it adds | Written by |
|---|---|---|
| `0001_initial_schema.sql` | The schema: tables, RLS, triggers, views, roles | Karam |
| `0002_debtor_phones_last_inbound.sql` | `debtor_phones.last_inbound_at` and `app.whatsapp_window_open()` (24-hour rule) | Sal, reviewed by Karam |
| `0003_worker_policies.sql` | A `worker_all` policy on every RLS table, so the worker sees all clients without `BYPASSRLS` | Sal, reviewed by Karam |
| `0004_data_intake.sql` | `app.next_ref()` reference numbers, import reports, one record per instrument | Karam |
| `0005_scheduler.sql` | On `follow_up_tasks`: `approved_by`/`approved_at`, `tries`, `last_error`, `finished_at`, and at most one open reminder and one open legal task per debt | Sal, **waiting for Karam's review** (PR #10) |

Other files in `/db`: `db/roles/login_roles.sql` and `db/roles/check_login_roles.sql` (login roles for development and production, see "Setting up a new database"), written by Sal and reviewed by Karam.

- Three schemas: `app` (business data), `ai` (document chunks, AI usage log), `audit` (append-only activity log).
- Primary keys are UUIDs. Money is `numeric(12,2)` in SAR, never floats. Times are `timestamptz` (UTC stored, Asia/Riyadh shown).
- **Tenant isolation:** every tenant table has `client_id`, and Row Level Security filters by it. Every API request must run inside a transaction that starts with:
  ```sql
  SET LOCAL app.client_id = '<client uuid>';
  SET LOCAL app.user_id   = '<user uuid>';      -- omit for system actions
  SET LOCAL app.actor_type = 'user';            -- or 'system', 'ai'
  ```
- Database roles: group roles `talos_app` (API, RLS applies) and `talos_worker` (scheduler and webhooks, sees all clients). Login roles `talos_api` (in `talos_app`) and `talos_jobs` (in `talos_worker`). Keep worker code small and careful.
  - The worker sees all clients through a `worker_all` policy on every RLS table (`0003_worker_policies.sql`), **not** through `BYPASSRLS`. `BYPASSRLS` is not inherited through membership, and managed databases do not let you grant it. No application role has any special attribute.
  - Any new table with Row Level Security needs a `worker_all` policy too. `db/roles/check_login_roles.sql` fails if one is missing.
  - The API account must never be in `talos_worker` (it would see every client). `assertRlsEnforced` refuses to start if it is.
  - Login roles are created by `db/roles/login_roles.sql`, the same file for development and production. See "Setting up a new database" below.
- The database already enforces these, so do not duplicate or fight them in code:
  - Approved payments recalculate `debts.amount_outstanding`; reaching zero marks the debt `paid` and cancels pending reminders.
  - A new open dispute marks the debt `disputed` and cancels pending reminders.
  - Changes to key tables are written to `audit.activity_log` automatically. The log cannot be edited or deleted.
  - A payment cannot leave `pending_approval` without a reviewer. A legal case cannot move past `ready` without approval.
  - A debt has at most one open (`pending` or `running`) `send_reminder` task and one open `mark_legal_ready` task (`follow_up_tasks_one_open`, 0005). Insert those with `ON CONFLICT ... DO NOTHING`; promise checks are not limited. `approved_by` and `approved_at` are set together or not at all.
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

### Scheduler (Phase 2)

- **A separate process:** `npm run scheduler` (keeps running) or `npm run scheduler -- --once` (one round). It needs both `DATABASE_URL` (`talos_api`) and `WORKER_DATABASE_URL` (`talos_jobs`). Several copies can run at once.
- **The worker connection only finds and claims work** across clients (`claimTasks`, `recoverStaleTasks`, the planner's search). Everything else runs inside `withTenant` with `actor_type = 'system'`, so RLS and the audit log apply.
- **Never two reminders for one debt.** Tasks are claimed in one statement with `FOR UPDATE SKIP LOCKED`; the database allows one open (`pending` or `running`) reminder and one open legal task per debt (`follow_up_tasks_one_open`, migration 0005). Insert tasks with `ON CONFLICT ... DO NOTHING` (see `planNext`). Reminders go through `sendReminder`, never straight to Meta.
- **A task stopped half way** (crash, restart) is recovered after `SCHEDULER_STALE_MINUTES`: put back if nothing was saved; closed if its reminder was already saved; a reminder left `queued` is never resent (staff are told to check).
- **Stop rules are checked again when a task runs**, not only when it is planned: paid, promised or any open promise, disputed, paused (`paused_until`), legal, closed, debtor not active, no attempts left. A reminder sent by hand, or a reply from the debtor, moves the next one a full interval later. Outside working hours a task waits for the next working time (client time zone, `api/src/scheduler/time.ts`).
- **`auto_send = false`** (the default): reminders are planned but wait for staff (`GET /api/reminders/waiting`, `POST /api/reminders/approve`). Stop rules still apply at sending.
- **Templates:** first reminder, then follow-up, then `final_notice` for the last one (follow-up if there is no final notice template).
- **Promises:** every open promise gets a `promise_check` at 10:00 client time on the day after `promise_grace_days`. Kept, partly kept or broken is decided in SQL from approved payments made after the promise (money never becomes a JavaScript number). A receipt waiting for approval delays the check by a day. A new promise cancels older open ones.
- **Legal:** after `max_attempts` reminders and one more interval with no reply, the debt becomes `legal_ready` and the client is told. A reply after the last reminder goes to a person instead, and is not tried again until there is new contact.
- **Failures:** a temporary Meta error is retried (15, then 30 minutes, 3 tries in total); other failures fail the task and tell staff, and the debt is not planned again for a day.
- **Times the scheduler writes come from its own clock** (`deps.now`), so its later comparisons use the same clock. Tests use a fixed clock.

### Getting data in (Phase 3)

- **One set of rules for every value that comes in.** `api/src/intake/normalize.ts` (phones, ID numbers, amounts, dates, list values in English or Arabic) and `api/src/intake/records.ts` (a whole debtor, debt or instrument) are used by both manual entry and the Excel import. Change a rule there, never in a route, so both stay the same.
- Errors stop a save and come back as `errors: [{ field, message }]`. Warnings never block (for example a wrong check digit in an ID number) and come back with the saved record.
- Phones are stored as `+E.164`. Saudi numbers may be typed as 05XXXXXXXX or 5XXXXXXXX (Excel drops the 0). Dates are Gregorian, day before month; Hijri dates are refused with a message.
- Reference numbers come from `app.next_ref('debtor' | 'debt')` (migration 0004): `D-000123`, `DBT-2026-0042`, per client, never repeated. A reference typed by the client is kept.
- **Several debts per debtor, each with its own instrument.** Instruments belong to the debtor; debts point to one. The same type and reference number (spaces and letter case ignored) is one instrument, shared by its debts (`instruments_one_per_reference`). Reuse it with `pickInstrument` instead of inserting a copy.
- New records are written with the bulk functions in `api/src/intake/write.ts` (one statement for a whole list, ids made in code).
- **Excel import:** one row per debt; rows with the same ID number are one debtor. Upload gives a check report and stores the parsed rows; nothing else is saved. Confirm checks the rows again against the current data and saves everything in one transaction, or nothing. Debtors already stored keep their details: only new debts and phones are added. Parsed rows are deleted from `app.imports` once the import is confirmed or cancelled. Limits: 5 MB, 5,000 rows.
- **Files:** go through `FileStorage` (`api/src/storage/storage.ts`), never straight to disk or a bucket. Store the bytes first (`storeFile`, outside the transaction), then the row (`insertDocumentRow`, inside it), and remove the file if the row fails. The file type comes from the file's first bytes (`detectFileType`), never from its name. Production uses the Dammam bucket (`docs/file-storage.md`); `STORAGE_DRIVER=local` is refused there.
- With `@fastify/multipart`, options passed to `req.file()` replace all the plugin's limits, so always pass the full `UPLOAD_LIMITS` (see `readUpload`).
- Enforceability (`/api/enforceability`): paper promissory notes and bills of exchange (`has_time_limit`) lose direct force one year after the new Enforcement Law starts. Set `ENFORCEMENT_LAW_START_DATE` once the date is published; until then they are flagged with no deadline.

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
- Uploaded files are personal data too: only in the private Dammam bucket in production. Local development files go to `api/.data/` (ignored by git); never commit them.
- This repository is public: keep business plans, pricing and client names out of it.

## Build plan and progress

This is the full list of steps to build the product. Finished steps are ticked and crossed out, with where the work lives. Keep this list up to date in every pull request that finishes or adds a step, so whoever picks up next (Sal, Karam or Claude) knows where things stand.

Owner: **S** = Sal (API, worker, web, AI), **K** = Karam (database, infrastructure, accounts), **S+K** = together.

### Where things stand (last updated 8 November 2026)

- Merged: the database, the back end API, WhatsApp reminders out, and the WhatsApp agent that reads replies and answers them.
- Phase 2 (the scheduler) is built: automatic reminders (or staff-approved ones), promise checks, the legal-ready step and a daily summary. Tested with a fake WhatsApp sender only. Its migration `0005_scheduler.sql` is in Karam's area and waits for his review.
- Phase 3 (getting data in) is built on the API side: manual entry, Excel import with a check report, document upload and the enforceability summary. The screens for them come in Phase 4. Files are stored locally in development; the Dammam bucket is set up with step 6.1 (3.3b).
- Not tested with the real services yet: everything Meta and Gemini related is tested with fakes only. The first real run is step 1.9.
- Nothing is hosted yet. There is no production database and no user login (only the development headers).
- The database setup is ready for a managed database (no superuser needed): the migrations, then one script. It was tested on a simulated one; see "Setting up a new database".
- Open decision: should the agent reply outside working hours (`AGENT_REPLY_OUTSIDE_HOURS`)? Today the reply is held and staff are alerted.

### Pick up here

1. Pull `main`, then `docker compose up -d` and `./scripts/db-reset.sh` (fresh dev database with fake data).
2. `cd api && npm install && npm test` (all tests must pass before you change anything).
3. Choose the next unticked step for your area below, and work on a branch named `<you>/<step>`.
4. Open a pull request into `main` (not into another feature branch), and tick the step here in the same pull request.

### Setting up a new database (production or staging)

Run these in order, as the admin account the provider gives you (it does not need to be a superuser):

1. Ask the provider to enable the `vector`, `pgcrypto` and `citext` extensions on the database, if the admin cannot.
2. Every file in `db/migrations`, in order: `psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f db/migrations/<file>`.
3. `ADMIN_DATABASE_URL="$ADMIN_URL" ./scripts/create-login-roles.sh` creates `talos_api` and `talos_jobs` with random 40-character passwords, checks them, and prints `DATABASE_URL` and `WORKER_DATABASE_URL` once. Put them straight into the secret manager. Rerun it to rotate the passwords.

`$ADMIN_URL` must name the application database (not `postgres`) and should use `sslmode=require`. Never load `dev/seed.sql` outside development.

### Phase 0: Foundations

- [x] ~~0.1 Public GitHub repository, CLAUDE.md, README, `.env.example`, CI checks (S)~~ (`.github/workflows/db-checks.yml`)
- [x] ~~0.2 Database schema: clients, users, debtors, debts, instruments, documents, messages, promises, payments, disputes, legal cases, rules, audit log, RLS, triggers (K)~~ (`db/migrations/0001_initial_schema.sql`)
- [x] ~~0.3 Debtor phones remember the last message received, for the 24-hour window (S, reviewed by K)~~ (`db/migrations/0002_debtor_phones_last_inbound.sql`)
- [x] ~~0.4 Local dev database with fake seed data, login roles and safety checks (S)~~ (`docker-compose.yml`, `scripts/db-reset.sh`, `dev/`)
- [x] ~~0.5 Back end skeleton: per-request client setting, dev login, roles, dashboard reads, payment approve and reject (S)~~ (`api/src/`)
- [x] ~~0.6 Meta business portfolio and domain verification for talosksa.com (S)~~
- [ ] 0.7 Meta business verification: submitted, waiting for Meta (S)
- [x] ~~0.8 Login roles for the API and the worker with strong passwords, working on managed databases (no superuser, no `BYPASSRLS`) (S, review by K)~~ (`db/roles/`, `db/migrations/0003_worker_policies.sql`, `scripts/create-login-roles.sh`)
- [ ] 0.9 Legal check with a Saudi lawyer: client authorization wording, debtor consent clause, filing on clients' behalf, whether any license is needed (S+K)
- [x] ~~0.10 Remove `BYPASSRLS` from `talos_worker` in `0001`, so the migrations run on a managed database with no workaround (approved by K; safe because 0001 had never been applied to a real database)~~ (`db/migrations/0001_initial_schema.sql`)

### Phase 1: WhatsApp agent

- [x] ~~1.1 Send reminder templates through the Meta Cloud API, with stop rules, working hours and the development redirect (S)~~ (`api/src/whatsapp/`, `POST /api/debts/:id/send-reminder`, `npm run whatsapp:ping`)
- [x] ~~1.2 Webhook: Meta signature check, every event stored first, retries ignored, delivery and read status updates (S)~~ (`api/src/routes/webhooks.ts`)
- [x] ~~1.3 Match an incoming message to the debtor and client by phone (S)~~ (`api/src/agent/inbound.ts`)
- [x] ~~1.4 AI reply from the debtor's own records, behind a swappable AI interface (Gemini free tier in development) (S)~~ (`api/src/ai/llm.ts`, `api/src/agent/prompt.ts`)
- [x] ~~1.5 Check every AI reply: amounts must come from the database, no threats, safe fallback reply and staff alert (S)~~ (`api/src/agent/decision.ts`)
- [x] ~~1.6 Act on replies: promise to pay with a follow-up check, dispute (stops reminders), wrong number, opt-out, receipt alert (S)~~ (`api/src/agent/inbound.ts`)
- [x] ~~1.7 Log every AI call in `ai.agent_runs` (S)~~
- [x] ~~1.8 Tests with a fake AI and a fake WhatsApp sender, fresh database per test file (S)~~ (`api/test/`)
- [ ] 1.9 First real end-to-end test: Gemini key, public tunnel, webhook set in Meta, reminder to Sal's phone and a reply back (S)
- [ ] 1.10 Write the real reminder templates (Arabic, English, Urdu, Bengali, Hindi) and submit them to Meta for approval (S)
- [ ] 1.11 Send held replies: replies held outside working hours go out when hours start, or staff send them from the dashboard (S)
- [ ] 1.12 Retry job for webhook events that failed or were never processed (S)
- [ ] 1.13 Receipts: download the image from Meta, store it securely, let the AI read amount, date and bank, create a payment `pending_approval` for staff (S, storage from K)
- [ ] 1.14 Answer from the client's own documents: split documents into chunks, embeddings in `ai.document_chunks` (pgvector), search them in the prompt (S, index tuning by K)
- [ ] 1.15 Staff can take over a conversation and reply by hand, using a template when the 24-hour window is closed (S)

### Phase 2: Scheduler (`api/src/scheduler`)

- [x] ~~2.1 Worker process that runs due tasks from `app.follow_up_tasks` safely (one task at a time, no double sends) (S)~~ (`api/src/scheduler/`, `npm run scheduler`, migration 0005)
- [x] ~~2.2 Automatic reminders following each client's `app.follow_up_rules` (interval, number of attempts, hours, days), with staff approval when `auto_send` is off (S)~~ (`api/src/scheduler/planner.ts`, `tasks.ts`, `api/src/routes/reminders.ts`)
- [x] ~~2.3 Promise checks: mark a promise kept or broken on its date and restart reminders when broken (S)~~ (`api/src/scheduler/tasks.ts`)
- [x] ~~2.4 After the last attempt with no reply, mark the debt ready for legal and alert the client (S)~~ (`api/src/scheduler/tasks.ts`)
- [x] ~~2.5 Daily summary notification for each client (S)~~ (`api/src/scheduler/summary.ts`)
- [ ] 2.6 Run the scheduler in production next to the API, as its own process (K, with 6.8)

### Phase 3: Getting data in

- [x] ~~3.1 Excel template and import with validation: phone format, duplicate IDs, missing amounts, clear error report per row (K)~~ (`api/src/import/`, `api/src/routes/imports.ts`, `/api/imports`)
- [x] ~~3.2 Add and edit debtors and debts by hand (K)~~ (`api/src/intake/`, `api/src/routes/debtors.ts`, migration 0004)
- [x] ~~3.3 Secure file storage for documents, encrypted, in Saudi Arabia: code (K)~~ (`api/src/storage/`, `docs/file-storage.md`)
- [ ] 3.3b Create the Dammam bucket and service account once the Google Cloud account exists (K, with 6.1)
- [x] ~~3.4 Upload documents per debtor and per debt (K)~~ (`api/src/routes/documents.ts`, `/api/documents`)
- [x] ~~3.5 Classify each debt by its instrument and show how much is directly enforceable; flag paper promissory notes that will lose force (K)~~ (`api/src/routes/enforceability.ts`, `/api/enforceability`)

### Phase 4: Client dashboard and CRM (`/web`)

- [ ] 4.1 React app shell, Arabic (right to left) and English (S)
- [ ] 4.2 Real login for client staff, replacing the development headers (S+K)
- [ ] 4.3 Main numbers: owed, recovered, promised, disputed, in legal, enforceable share (S)
- [ ] 4.4 Debtor list with filters and search (S)
- [ ] 4.5 Debtor page with full timeline: messages, promises, payments, disputes, documents (S)
- [ ] 4.6 Approval queue: approve or reject payments, resolve disputes (S)
- [ ] 4.7 Notifications: replies, payments to approve, disputes, legal-ready debts (S)
- [ ] 4.8 Settings: follow-up rules, working hours, languages, templates, users and roles (S)
- [ ] 4.9 Client sign-up: CR, establishment contract, owner details, IBAN, signed authorization (S)

### Phase 5: Legal escalation

- [ ] 5.1 Filing pack: PDF with debtor details, amount, instrument, Najiz request type and sub type, full contact history as proof, plus all documents (S)
- [ ] 5.2 Client approval before a case moves past `ready` (database already enforces it) (S)
- [ ] 5.3 Case status tracking, entered by hand at first (S)

### Phase 6: Production

- [ ] 6.1 Choose a Saudi cloud provider and region; separate development and production environments (K)
- [ ] 6.2 Managed PostgreSQL with pgvector, backups and a tested restore, set up as in "Setting up a new database" (K)
- [ ] 6.3 Secrets management (Meta token, app secret, AI key); never in the repository (K)
- [ ] 6.4 Public HTTPS address for the API and the Meta webhook (K)
- [ ] 6.5 Paid AI plan with data terms that allow real debtor data (the free tier is refused in production) (S+K)
- [ ] 6.6 Real WhatsApp sender number, display name approved, payment method in Meta (K)
- [ ] 6.7 Monitoring and alerts: failed sends, webhook errors, AI errors and cost (K)
- [ ] 6.8 Deploy pipeline from `main` (K)
- [ ] 6.9 Pilot with the first client: load real debts, measure money recovered, reply rate, dispute rate and staff time (S+K)

### Later (after the first version)

- [ ] L.1 Payment links that pay straight into the client's own bank account (S, gateway account by K)
- [ ] L.2 SMS as a backup channel (S)
- [ ] L.3 Voice agent with an Arabic voice provider (S)
- [ ] L.4 One WhatsApp number per client through Meta Tech Provider sign-up (K)
- [ ] L.5 Help clients issue promissory notes on Nafith at hiring (S+K)
- [ ] L.6 Sector playbooks, starting with construction (S)

## Conventions

- Small pull requests, merged daily. One branch per person per feature, for example `sal/whatsapp-webhook`, `karam/add-unified-number`.
- Write tests for anything touching money, stop rules or tenant isolation.
- No em dashes in user-facing text. Simple words in Arabic and English.
