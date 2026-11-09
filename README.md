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

### Dashboard (web)

```bash
cd web
npm install
npm run dev                   # http://localhost:5173, talks to the API on :3000
npm test                      # screen tests with sample data (English and Arabic)
VITE_DEMO=1 npm run dev       # the same screens with sample data, no API needed
npm run build:prototype       # one HTML file with sample data, for design review
npm run e2e                   # real browser against the real API and a fresh dev database
```

The end-to-end run (`web/e2e`) logs in, resets passwords, invites a person, records and approves
payments, decides a dispute, pauses, adds a debtor, imports an Excel file and changes settings,
then checks each result through the API. It opens every page in English and Arabic, light and
dark, at desktop and phone width, and fails on any page wider than the screen, English left in an
Arabic page, a browser error or an accessibility problem (axe-core, WCAG 2.1 AA). It needs the API
running with `AUTH_MODE=session` and `MAIL_DRIVER=log`, the dashboard on :5173, `ADMIN_DATABASE_URL`,
Python with `openpyxl`, and Chromium for Playwright. CI runs it on every pull request.

### Back end API

```bash
cd api
cp .env.example .env          # local settings; never commit .env
npm install
npm run dev                   # starts on http://localhost:3000
npm test                      # resets a separate talos_test database and runs the tests
```

Staff log in with email and password (step 4.2): the dashboard gets an HttpOnly cookie, and every
request that changes something must also send the header `x-talos: 1`. The fake users are
`owner@demo.example` and `staff@demo.example`, password `talos-dev-password`. Password reset and
invitation emails are written to `api/.data/mail` in development (`MAIL_DRIVER=log`).

With `AUTH_MODE=dev` (development only) you can also call the API with two headers instead:

```
x-client-id: 11111111-1111-4111-8111-111111111111
x-user-id:   22222222-2222-4222-8222-000000000002
```

| Method | Path | What it does |
|---|---|---|
| POST | `/api/auth/login` | `{ email, password }`: sets the login cookie |
| POST | `/api/auth/logout` | Ends this session |
| POST | `/api/auth/forgot` | `{ email }`: emails a reset link if the account exists (always answers 202) |
| GET / POST | `/api/auth/reset` | Check a reset or invitation link; `{ token, password }` sets the password |

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
| GET | `/api/dashboard/summary` | Count and amount per debt status, reminders sent, open promises, legal |
| GET | `/api/notifications` | `{ unread, items }`; each item has `data` the dashboard turns into Arabic or English |
| POST | `/api/notifications/read` | `{ ids }` or `{ all: true }` |
| POST | `/api/debts/:id/payments` | Record a payment received outside WhatsApp (approved at once, in your name) |
| POST | `/api/debts/:id/pause`, `/resume` | Stop reminders `{ reason, until? }`, or start them again |
| POST | `/api/disputes/:id/resolve` | `{ outcome: "amount_correct" }` or `{ outcome: "debtor_right", action: "correct_amount" \| "close" \| "pause" }` |
| GET / PATCH | `/api/settings/rules` | Follow-up rules (changes: owner, admin) |
| GET | `/api/templates` | Message templates and their WhatsApp approval |
| GET / POST / PATCH | `/api/users`, `/api/users/:id` | The team: invite, change role, remove access (owner, admin) |
| POST | `/api/users/:id/invite` | Send the invitation email again |

Getting data in (Phase 3). Changes need owner, admin or staff; viewers can only read.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/instrument-types` | Instrument types with their Najiz names (for dropdowns) |
| GET | `/api/debtors?search=&limit=&offset=` | Find debtors by name, reference, ID number or phone |
| POST | `/api/debtors` | New debtor with `phones` and optional `debts` (each with an `instrument`) |
| PATCH | `/api/debtors/:id` | Change debtor details or `status` |
| POST | `/api/debtors/:id/phones` | Add a phone |
| PATCH | `/api/phones/:id` | `status` (wrong_number, opted_out...), `label`, `is_primary` |
| GET / POST | `/api/debtors/:id/instruments` | List or add instruments (promissory notes, cheques...) |
| PATCH | `/api/instruments/:id` | Change an instrument; `{ "verified": true }` marks the original as checked |
| POST | `/api/debtors/:id/debts` | Add one debt, or `{ "debts": [...] }` |
| PATCH | `/api/debts/:id` | Change a debt, its `instrument`, or correct its `amount` |
| GET | `/api/imports/template` | The Excel template |
| POST | `/api/imports` | Upload a filled template (multipart, field `file`): returns the check report |
| GET | `/api/imports`, `/api/imports/:id` | Recent imports, one import with its report |
| POST | `/api/imports/:id/confirm` | Save every row together (all or nothing) |
| POST | `/api/imports/:id/cancel` | Drop an import |
| POST | `/api/documents` | Upload a PDF or photo (multipart: `doc_type`, `debtor_id` / `debt_id` / `instrument_id`, then `file`) |
| GET | `/api/documents?debtor_id=` (or `debt_id`, `instrument_id`, `scope=client`) | List documents |
| GET | `/api/documents/:id/download` | Download a document |
| GET | `/api/enforceability` | Share of open debt that can go straight to Najiz, by instrument, and paper notes at risk |

Errors in what was sent give `400` with `errors: [{ field, message }]`. Warnings never
block: they come back with the saved record. Records of another client give `404`.

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

### WhatsApp agent (replies to debtors)

When a debtor writes back, Meta calls `POST /webhooks/whatsapp`. The server:

1. checks Meta's signature, stores the event in `app.webhook_events` (Meta's retries are ignored),
2. finds the debtor by phone number and saves the message,
3. asks the AI what the message means, giving it only this debtor's records,
4. checks the AI's reply: every amount must come from the database (or the debtor's own words),
   and no threats or mentions of family, employer or police. A failed check, or an AI error, is
   replaced by a safe "our team will contact you" reply and staff are alerted,
5. acts on it: records a promise to pay (and a check after the date), opens a dispute (which stops
   reminders), marks a wrong or opted-out number, or alerts staff about a receipt,
6. replies within working hours, or holds the reply for staff outside them,
7. logs the AI call in `ai.agent_runs`.

To try it in development:

1. In `api/.env`, set `WORKER_DATABASE_URL`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
   `AI_PROVIDER=gemini` and `AI_API_KEY` (a free key from Google AI Studio). The free tier is for
   fake data only: Google may use free-tier prompts to improve its models, so the server refuses it
   in production.
2. Make the server reachable from the internet (for example `npx localtunnel --port 3000` or a
   Replit deployment), then in Meta, WhatsApp, Configuration, set the callback URL to
   `https://<your address>/webhooks/whatsapp`, the verify token to `WHATSAPP_VERIFY_TOKEN`, and
   subscribe to `messages`.
3. Send a reminder (above), then reply from your phone. In development, messages from
   `WHATSAPP_DEV_REDIRECT_TO` are treated as coming from the last debtor you messaged.

### Scheduler (automatic reminders)

The scheduler is a separate process. It plans and sends reminders, checks promises to
pay, marks debts ready for legal, and writes a daily summary for each client.

```bash
cd api
npm run scheduler -- --once   # one round, then stop (good for trying it)
npm run scheduler             # keeps running, every SCHEDULER_POLL_SECONDS
```

It needs `DATABASE_URL` and `WORKER_DATABASE_URL`. Without WhatsApp settings it still
plans and checks promises, but reminders wait. The demo client has `auto_send` off,
so reminders also wait for a staff member:

| Method | Path | What it does |
|---|---|---|
| GET | `/api/reminders/waiting` | Reminders due within a day that wait for approval |
| POST | `/api/reminders/approve` | `{ "task_ids": [...] }` or `{ "all": true }` (owner, admin, staff) |
| GET | `/api/debts/:id/tasks` | What is planned for a debt and what happened before |
| POST | `/api/tasks/:id/cancel` | Cancel a planned task with `{ "reason": "..." }` (owner, admin, staff) |

In production, run `npm run build` and then `node dist/src/scheduler/main.js` as its own
service next to the API (it stops cleanly on `SIGTERM`).

### Setting up a real database

`./scripts/db-reset.sh` is for development only. For production or staging, follow
"Setting up a new database" in `CLAUDE.md`: the migrations, then
`./scripts/create-login-roles.sh`, which makes the API and worker logins with random
passwords. It works on managed databases where the admin is not a superuser.

### Settings

Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.

## Status

Early development. Not for production use.
