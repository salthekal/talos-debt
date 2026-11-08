-- =====================================================================
-- Talos Debt Follow-up: PostgreSQL schema (version 1, for the MVP)
-- Target: PostgreSQL 15+ with pgvector, hosted in a Saudi region
-- Owner: Karam (databases and infrastructure)
--
-- Three schemas:
--   app    business data (clients, debtors, debts, messages, payments, legal)
--   ai     document chunks and embeddings for the agent, plus AI usage log
--   audit  append-only activity log (legal evidence)
--
-- Rules every table follows:
--   * Primary keys are UUIDs (safe to expose in URLs and APIs).
--   * Every tenant table has client_id, and child tables point to their
--     parent with (client_id, id) so a row can never link to another
--     client's data, even by a bug.
--   * Row Level Security (RLS) filters every query by the current client.
--     The app sets it once per request:  SET LOCAL app.client_id = '<uuid>';
--   * Money is numeric(12,2) in SAR. Never float.
--   * Times are timestamptz (stored in UTC, shown in Asia/Riyadh).
--   * Status lists use text + CHECK, which is easier to change later
--     than Postgres ENUM types.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive emails
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector for AI retrieval

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ai;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- The client the current request is acting for (set by the back end).
CREATE OR REPLACE FUNCTION app.current_client_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.client_id', true), '')::uuid
$$;

-- The logged-in user (or null for system / AI actions).
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- =====================================================================
-- 1. GLOBAL TABLES (shared by all clients, no client_id)
-- =====================================================================

-- Najiz executive instrument types (section 10 of the brief).
-- Reference data: seeded below, edited only by Talos.
CREATE TABLE app.instrument_types (
  code                 text PRIMARY KEY,
  name_en              text NOT NULL,
  name_ar              text,
  najiz_main_type      text,            -- أوراق تجارية / أحكام وقرارات / محاضر / عقود / أخرى
  najiz_sub_type       text,
  directly_enforceable boolean NOT NULL, -- can go straight to execution on Najiz
  has_time_limit       boolean NOT NULL DEFAULT false, -- e.g. paper notes under the new Enforcement Law
  sort_order           int NOT NULL DEFAULT 100
);

-- WhatsApp sender numbers. Global because in the pilot one Talos number
-- may serve several clients; later each client gets its own number.
CREATE TABLE app.sender_numbers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL DEFAULT 'meta_cloud_api',
  phone_number_id    text NOT NULL UNIQUE,  -- Meta's id for the number
  waba_id            text NOT NULL,         -- WhatsApp Business Account id
  display_phone      text NOT NULL,         -- +9665XXXXXXXX
  display_name       text NOT NULL,
  is_shared          boolean NOT NULL DEFAULT true,
  quality_rating     text CHECK (quality_rating IN ('green','yellow','red','unknown')) DEFAULT 'unknown',
  messaging_limit    text,                  -- tier reported by Meta
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','restricted','disabled')),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Raw incoming webhooks (WhatsApp, payment gateway) before processing.
-- Unique event id makes processing safe to repeat (Meta retries).
CREATE TABLE app.webhook_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider      text NOT NULL CHECK (provider IN ('whatsapp','payment_gateway','sms','voice')),
  event_id      text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text,
  UNIQUE (provider, event_id)
);
CREATE INDEX webhook_events_unprocessed ON app.webhook_events (received_at) WHERE processed_at IS NULL;

-- =====================================================================
-- 2. CLIENTS, USERS, SETTINGS
-- =====================================================================

CREATE TABLE app.clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name         text NOT NULL,          -- exactly as on the CR
  trade_name         text,
  cr_number          text NOT NULL UNIQUE,
  vat_number         text,
  sector             text NOT NULL DEFAULT 'logistics'
                     CHECK (sector IN ('logistics','labor_services','construction','other')),
  activity           text,
  owner_name         text NOT NULL,
  owner_phone        text NOT NULL,
  owner_email        citext NOT NULL,
  iban               text CHECK (iban ~ '^SA[0-9]{22}$'),  -- Saudi IBAN: SA + 22 digits
  bank_name          text,
  plan               text NOT NULL DEFAULT 'trial'
                     CHECK (plan IN ('trial','starter','growth','pro')),
  sender_number_id   uuid REFERENCES app.sender_numbers(id),
  authorization_signed_at timestamptz,      -- authorization for Talos to contact debtors
  status             text NOT NULL DEFAULT 'onboarding'
                     CHECK (status IN ('onboarding','active','suspended','closed')),
  timezone           text NOT NULL DEFAULT 'Asia/Riyadh',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES app.clients(id),
  full_name         text NOT NULL,
  email             citext NOT NULL,
  phone             text,
  role              text NOT NULL CHECK (role IN ('owner','admin','staff','viewer')),
  auth_provider_id  text UNIQUE,              -- id from the login provider; no passwords stored here
  is_active         boolean NOT NULL DEFAULT true,
  last_login_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, email)
);

-- One rule set per client for now (could become per debt category later).
CREATE TABLE app.follow_up_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              uuid NOT NULL UNIQUE REFERENCES app.clients(id),
  interval_days          int  NOT NULL DEFAULT 2  CHECK (interval_days BETWEEN 1 AND 30),
  max_attempts           int  NOT NULL DEFAULT 5  CHECK (max_attempts BETWEEN 1 AND 50),
  working_hours_start    time NOT NULL DEFAULT '09:00',
  working_hours_end      time NOT NULL DEFAULT '20:00',
  working_days           int[] NOT NULL DEFAULT '{0,1,2,3,4}', -- 0 = Sunday ... 6 = Saturday
  call_after_attempts    int,                                   -- null = no calls (MVP)
  legal_after_attempts   int  NOT NULL DEFAULT 5,
  promise_grace_days     int  NOT NULL DEFAULT 1,               -- days after a missed promise before follow-up
  languages              text[] NOT NULL DEFAULT '{ar,en}',
  auto_send              boolean NOT NULL DEFAULT false,        -- false = staff approve each batch
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (working_hours_end > working_hours_start)
);

-- =====================================================================
-- 3. DEBTORS, PHONES, DOCUMENTS, INSTRUMENTS, DEBTS
-- =====================================================================

CREATE TABLE app.debtors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES app.clients(id),
  ref_code           text NOT NULL,          -- short code shown in messages, e.g. D-000123
  debtor_kind        text NOT NULL DEFAULT 'person' CHECK (debtor_kind IN ('person','company')),
  id_type            text NOT NULL CHECK (id_type IN ('national_id','iqama','passport','cr','other')),
  id_number          text NOT NULL,
  full_name          text NOT NULL,
  full_name_ar       text,
  nationality        text,                   -- ISO country code, e.g. SA, PK, BD
  preferred_language text NOT NULL DEFAULT 'ar'
                     CHECK (preferred_language IN ('ar','en','ur','bn','hi')),
  national_address   text,
  employment_status  text NOT NULL DEFAULT 'unknown'
                     CHECK (employment_status IN ('current','left','unknown')),
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','paused','do_not_contact','closed')),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, ref_code),
  UNIQUE (client_id, id_type, id_number)   -- catches duplicate IDs on Excel import
);
CREATE INDEX debtors_name_idx ON app.debtors (client_id, full_name);

-- Each phone has its own status so stop rules work per number
-- (wrong number on one phone should not stop the others).
CREATE TABLE app.debtor_phones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL,
  debtor_id     uuid NOT NULL,
  phone_e164    text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  label         text,                 -- personal, work, from platform, ...
  is_primary    boolean NOT NULL DEFAULT false,
  has_whatsapp  boolean,              -- null = not checked yet
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','wrong_number','opted_out','unreachable')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, debtor_id, phone_e164),
  FOREIGN KEY (client_id, debtor_id) REFERENCES app.debtors (client_id, id) ON DELETE CASCADE
);
-- Inbound WhatsApp messages are matched to the debtor by phone.
CREATE INDEX debtor_phones_lookup ON app.debtor_phones (phone_e164);

-- Signed instruments (promissory note, cheque, judgment, ...).
-- Linked to the debtor, because one note signed at hiring can back
-- several debts. Each debt then points to its instrument.
CREATE TABLE app.instruments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL,
  debtor_id          uuid NOT NULL,
  type_code          text NOT NULL REFERENCES app.instrument_types(code),
  reference_number   text,                -- Nafith number, cheque number, judgment number
  issue_date         date,
  due_date           date,
  face_amount        numeric(12,2) CHECK (face_amount >= 0),
  enforceable_until  date,                -- set for paper notes once the new law has a start date
  verified_by        uuid,                -- staff member who checked the original
  verified_at        timestamptz,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debtor_id)  REFERENCES app.debtors (client_id, id),
  FOREIGN KEY (client_id, verified_by) REFERENCES app.users (client_id, id)
);

CREATE TABLE app.debts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL,
  debtor_id           uuid NOT NULL,
  instrument_id       uuid,               -- null = no executive instrument
  ref_code            text NOT NULL,      -- shown to the debtor, e.g. INV-2026-0042
  amount_original     numeric(12,2) NOT NULL CHECK (amount_original > 0),
  amount_outstanding  numeric(12,2) NOT NULL CHECK (amount_outstanding >= 0), -- kept up to date by trigger
  currency            char(3) NOT NULL DEFAULT 'SAR',
  reason              text NOT NULL,      -- in the client's words; the AI quotes this
  reason_category     text NOT NULL DEFAULT 'other'
                      CHECK (reason_category IN ('vehicle_rent','cash_on_delivery','damages','advance',
                                                 'invoice','equipment','fine','other')),
  issue_date          date,
  due_date            date,
  status              text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_follow_up','promised','partly_paid','paid','disputed',
                                        'paused','legal_ready','in_legal','written_off','closed')),
  status_changed_at   timestamptz NOT NULL DEFAULT now(),
  attempts_count      int NOT NULL DEFAULT 0,   -- outbound reminders sent so far
  last_contact_at     timestamptz,
  last_reply_at       timestamptz,
  paused_until        date,
  import_id           uuid,                     -- which Excel import created it
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (client_id, ref_code),
  FOREIGN KEY (client_id, debtor_id)     REFERENCES app.debtors (client_id, id),
  FOREIGN KEY (client_id, instrument_id) REFERENCES app.instruments (client_id, id),
  FOREIGN KEY (client_id, created_by)    REFERENCES app.users (client_id, id)
);
CREATE INDEX debts_by_debtor ON app.debts (client_id, debtor_id);
CREATE INDEX debts_by_status ON app.debts (client_id, status);

-- Metadata for every file. The file itself lives in encrypted object
-- storage (Saudi region); storage_key points to it.
-- Client-level files (CR, IBAN letter, authorization) have no debtor_id.
CREATE TABLE app.documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES app.clients(id),
  debtor_id      uuid,
  debt_id        uuid,
  instrument_id  uuid,
  doc_type       text NOT NULL CHECK (doc_type IN (
                   'cr','establishment_contract','iban_letter','authorization',   -- client
                   'national_id','iqama','employment_contract',                   -- debtor
                   'promissory_note','cheque','judgment','contract','invoice',
                   'receipt','payment_proof','legal_pack','import_file','other')),
  file_name      text NOT NULL,
  storage_key    text NOT NULL UNIQUE,
  mime_type      text NOT NULL,
  size_bytes     bigint NOT NULL CHECK (size_bytes > 0),
  sha256         text NOT NULL,          -- fingerprint: proves the file was not changed (evidence)
  source         text NOT NULL DEFAULT 'client_upload'
                 CHECK (source IN ('client_upload','whatsapp_inbound','system_generated')),
  uploaded_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debtor_id)     REFERENCES app.debtors (client_id, id),
  FOREIGN KEY (client_id, debt_id)       REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, instrument_id) REFERENCES app.instruments (client_id, id),
  FOREIGN KEY (client_id, uploaded_by)   REFERENCES app.users (client_id, id)
);
CREATE INDEX documents_by_debtor ON app.documents (client_id, debtor_id);

-- Excel import batches, with row-level errors for the validation screen.
CREATE TABLE app.imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL,
  document_id   uuid NOT NULL,          -- the uploaded Excel file
  rows_total    int NOT NULL DEFAULT 0,
  rows_ok       int NOT NULL DEFAULT 0,
  rows_failed   int NOT NULL DEFAULT 0,
  errors        jsonb NOT NULL DEFAULT '[]',  -- [{row: 12, field: "phone", error: "bad format"}]
  status        text NOT NULL DEFAULT 'validating'
                CHECK (status IN ('validating','ready','imported','failed','cancelled')),
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, document_id) REFERENCES app.documents (client_id, id),
  FOREIGN KEY (client_id, created_by)  REFERENCES app.users (client_id, id)
);
ALTER TABLE app.debts
  ADD FOREIGN KEY (client_id, import_id) REFERENCES app.imports (client_id, id);

-- =====================================================================
-- 4. MESSAGING
-- =====================================================================

-- client_id null = Talos default template available to every client.
CREATE TABLE app.message_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid REFERENCES app.clients(id),
  purpose             text NOT NULL CHECK (purpose IN ('first_reminder','follow_up','promise_reminder',
                                                       'final_notice','payment_received','payment_rejected')),
  language            text NOT NULL CHECK (language IN ('ar','en','ur','bn','hi')),
  meta_template_name  text NOT NULL,
  meta_category       text NOT NULL DEFAULT 'utility' CHECK (meta_category IN ('utility','marketing','authentication')),
  body                text NOT NULL,       -- with {{1}}, {{2}} placeholders
  variables           text[] NOT NULL DEFAULT '{}',   -- e.g. {debtor_name, amount, debt_ref}
  approval_status     text NOT NULL DEFAULT 'draft'
                      CHECK (approval_status IN ('draft','submitted','approved','rejected','paused')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (client_id, meta_template_name, language)
);

-- Every message in and out. Also the proof-of-contact for the legal pack.
CREATE TABLE app.messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL,
  debtor_id            uuid NOT NULL,
  debt_id              uuid,                -- null when the message covers all the debtor's debts
  phone_id             uuid,
  sender_number_id     uuid REFERENCES app.sender_numbers(id),
  channel              text NOT NULL CHECK (channel IN ('whatsapp','sms','call')),
  direction            text NOT NULL CHECK (direction IN ('outbound','inbound')),
  template_id          uuid REFERENCES app.message_templates(id),
  body                 text,
  media_document_id    uuid,                -- receipt image the debtor sent, etc.
  ai_generated         boolean NOT NULL DEFAULT false,
  sent_by              uuid,                -- staff member for manual sends
  status               text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','sent','delivered','read','failed','received')),
  provider_message_id  text UNIQUE,         -- WhatsApp message id (wamid)
  error_code           text,
  sent_at              timestamptz,
  delivered_at         timestamptz,
  read_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debtor_id)         REFERENCES app.debtors (client_id, id),
  FOREIGN KEY (client_id, debt_id)           REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, phone_id)          REFERENCES app.debtor_phones (client_id, id),
  FOREIGN KEY (client_id, media_document_id) REFERENCES app.documents (client_id, id),
  FOREIGN KEY (client_id, sent_by)           REFERENCES app.users (client_id, id)
);
CREATE INDEX messages_timeline ON app.messages (client_id, debtor_id, created_at DESC);

-- The scheduler's work queue: "send reminder 3 for debt X at 10:00 Sunday".
CREATE TABLE app.follow_up_tasks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL,
  debt_id            uuid NOT NULL,
  task_type          text NOT NULL CHECK (task_type IN ('send_reminder','promise_check','call','mark_legal_ready')),
  attempt_number     int,
  due_at             timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','done','skipped','cancelled','failed')),
  skip_reason        text,               -- e.g. 'debt_paid', 'disputed', 'outside_hours', 'client_paused'
  result_message_id  uuid,
  locked_at          timestamptz,        -- worker claims the task (SELECT ... FOR UPDATE SKIP LOCKED)
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debt_id)           REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, result_message_id) REFERENCES app.messages (client_id, id)
);
CREATE INDEX follow_up_tasks_due ON app.follow_up_tasks (due_at) WHERE status = 'pending';

CREATE TABLE app.promises (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL,
  debt_id            uuid NOT NULL,
  promised_amount    numeric(12,2) CHECK (promised_amount > 0),  -- null = "the full amount"
  promised_date      date NOT NULL,
  source_message_id  uuid,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','kept','partly_kept','broken','cancelled')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debt_id)           REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, source_message_id) REFERENCES app.messages (client_id, id)
);

CREATE TABLE app.disputes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL,
  debt_id            uuid NOT NULL,
  raised_message_id  uuid,
  reason             text NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_valid','resolved_invalid')),
  resolution_note    text,
  resolved_by        uuid,
  resolved_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debt_id)           REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, raised_message_id) REFERENCES app.messages (client_id, id),
  FOREIGN KEY (client_id, resolved_by)       REFERENCES app.users (client_id, id)
);

-- =====================================================================
-- 5. PAYMENTS
-- =====================================================================

-- Payment links (version 2). Money settles into the client's account, never Talos's.
CREATE TABLE app.payment_links (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL,
  debt_id          uuid NOT NULL,
  amount           numeric(12,2) NOT NULL CHECK (amount > 0),
  gateway          text NOT NULL,
  gateway_link_id  text NOT NULL,
  url              text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paid','expired','cancelled')),
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (gateway, gateway_link_id),
  FOREIGN KEY (client_id, debt_id) REFERENCES app.debts (client_id, id)
);

-- Only 'approved' payments reduce the balance (client approves every proof).
CREATE TABLE app.payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL,
  debt_id             uuid NOT NULL,
  amount              numeric(12,2) NOT NULL CHECK (amount > 0),
  method              text NOT NULL CHECK (method IN ('payment_link','bank_transfer','cash','salary_deduction','other')),
  paid_at             timestamptz,
  proof_document_id   uuid,
  source_message_id   uuid,
  payment_link_id     uuid,
  extracted_details   jsonb,              -- what the AI read from the receipt: bank, date, amount, reference
  ai_match_confidence numeric(3,2) CHECK (ai_match_confidence BETWEEN 0 AND 1),
  status              text NOT NULL DEFAULT 'pending_approval'
                      CHECK (status IN ('pending_approval','approved','rejected')),
  rejection_reason    text,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debt_id)           REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, proof_document_id) REFERENCES app.documents (client_id, id),
  FOREIGN KEY (client_id, source_message_id) REFERENCES app.messages (client_id, id),
  FOREIGN KEY (client_id, payment_link_id)   REFERENCES app.payment_links (client_id, id),
  FOREIGN KEY (client_id, reviewed_by)       REFERENCES app.users (client_id, id),
  CHECK (status = 'pending_approval' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX payments_to_review ON app.payments (client_id, created_at) WHERE status = 'pending_approval';

-- =====================================================================
-- 6. LEGAL
-- =====================================================================

CREATE TABLE app.legal_cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL,
  debt_id             uuid NOT NULL,
  instrument_id       uuid,
  amount_claimed      numeric(12,2) NOT NULL CHECK (amount_claimed > 0),
  najiz_main_type     text,
  najiz_sub_type      text,
  pack_document_id    uuid,              -- generated filing pack (PDF + bundle)
  approved_by         uuid,              -- human approval is required before submitting
  approved_at         timestamptz,
  submitted_by_name   text,              -- the client's authorized person or lawyer
  submitted_at        timestamptz,
  najiz_request_number text,
  court_name          text,
  status              text NOT NULL DEFAULT 'ready'
                      CHECK (status IN ('ready','approved','submitted','order_issued','measures_applied',
                                        'settled','closed','withdrawn')),
  status_note         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, debt_id)          REFERENCES app.debts (client_id, id),
  FOREIGN KEY (client_id, instrument_id)    REFERENCES app.instruments (client_id, id),
  FOREIGN KEY (client_id, pack_document_id) REFERENCES app.documents (client_id, id),
  FOREIGN KEY (client_id, approved_by)      REFERENCES app.users (client_id, id),
  CHECK (status IN ('ready','withdrawn') OR approved_by IS NOT NULL)
);
-- Only one open legal case per debt.
CREATE UNIQUE INDEX legal_cases_one_open ON app.legal_cases (debt_id)
  WHERE status NOT IN ('closed','withdrawn','settled');

-- =====================================================================
-- 7. NOTIFICATIONS (for client users)
-- =====================================================================

CREATE TABLE app.notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL,
  user_id      uuid,                    -- null = all users of the client
  kind         text NOT NULL CHECK (kind IN ('reply','payment_to_review','dispute','legal_ready',
                                             'promise_broken','import_done','system')),
  title        text NOT NULL,
  target_table text,
  target_id    uuid,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, user_id) REFERENCES app.users (client_id, id)
);
CREATE INDEX notifications_unread ON app.notifications (client_id, created_at DESC) WHERE read_at IS NULL;

-- =====================================================================
-- 8. AI SCHEMA
-- =====================================================================

-- Text chunks of the client's documents with embeddings, for retrieval.
-- 1536 dimensions fits common embedding models; change it to match the
-- model Sal picks BEFORE loading data.
CREATE TABLE ai.document_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL,
  document_id   uuid NOT NULL,
  debtor_id     uuid,                    -- null = client-wide document (policies, contract template)
  chunk_index   int NOT NULL,
  content       text NOT NULL,
  embedding     vector(1536) NOT NULL,
  model         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index),
  FOREIGN KEY (client_id, document_id) REFERENCES app.documents (client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, debtor_id)   REFERENCES app.debtors (client_id, id)
);
CREATE INDEX document_chunks_embedding ON ai.document_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX document_chunks_scope ON ai.document_chunks (client_id, debtor_id);

-- Every AI call: what it did, which model, tokens and cost.
-- Answers "how much does each client cost us to run?" (pricing concern 3).
CREATE TABLE ai.agent_runs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id       uuid NOT NULL,
  debtor_id       uuid,
  message_id      uuid,
  purpose         text NOT NULL CHECK (purpose IN ('reply','receipt_read','promise_extract',
                                                   'dispute_detect','classify_instrument','legal_pack')),
  model           text NOT NULL,
  input_tokens    int,
  output_tokens   int,
  cost_usd        numeric(10,5),
  output          jsonb,                 -- structured result (intent, extracted amount, ...)
  needs_human     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (client_id, debtor_id)  REFERENCES app.debtors (client_id, id),
  FOREIGN KEY (client_id, message_id) REFERENCES app.messages (client_id, id)
);
CREATE INDEX agent_runs_cost ON ai.agent_runs (client_id, created_at);

-- =====================================================================
-- 9. AUDIT SCHEMA (append only)
-- =====================================================================

CREATE TABLE audit.activity_log (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id     uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','system','ai','debtor')),
  actor_id      uuid,
  action        text NOT NULL,          -- e.g. 'payments.update', 'debt.marked_legal_ready'
  target_table  text,
  target_id     uuid,
  details       jsonb,                  -- {old: {...}, new: {...}} for automatic entries
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_log_target ON audit.activity_log (client_id, target_table, target_id, created_at);

-- Block any edit or delete, even by mistake.
CREATE OR REPLACE FUNCTION audit.block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit.activity_log is append-only';
END $$;

CREATE TRIGGER activity_log_append_only
  BEFORE UPDATE OR DELETE ON audit.activity_log
  FOR EACH ROW EXECUTE FUNCTION audit.block_changes();
-- TRUNCATE skips row triggers, so block it separately.
CREATE TRIGGER activity_log_no_truncate
  BEFORE TRUNCATE ON audit.activity_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.block_changes();

-- Automatic log of every change to the important tables.
-- Runs as the table owner so the app role never needs write access to audit.
CREATE OR REPLACE FUNCTION audit.log_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_actor_type text := coalesce(nullif(current_setting('app.actor_type', true), ''),
                                CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END);
  v_row  jsonb := to_jsonb(coalesce(NEW, OLD));
BEGIN
  INSERT INTO audit.activity_log (client_id, actor_type, actor_id, action, target_table, target_id, details)
  VALUES (
    (v_row->>'client_id')::uuid,
    v_actor_type,
    app.current_user_id(),
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    (v_row->>'id')::uuid,
    CASE TG_OP
      WHEN 'INSERT' THEN jsonb_build_object('new', to_jsonb(NEW))
      WHEN 'DELETE' THEN jsonb_build_object('old', to_jsonb(OLD))
      ELSE jsonb_build_object('old', to_jsonb(OLD), 'new', to_jsonb(NEW))
    END
  );
  RETURN coalesce(NEW, OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['debtors','debtor_phones','instruments','debts','documents',
                           'promises','disputes','payments','legal_cases','follow_up_rules']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t, t);
  END LOOP;
END $$;

-- =====================================================================
-- 10. BUSINESS TRIGGERS
-- =====================================================================

CREATE TRIGGER clients_updated_at  BEFORE UPDATE ON app.clients  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER users_updated_at    BEFORE UPDATE ON app.users    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER debtors_updated_at  BEFORE UPDATE ON app.debtors  FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER debts_updated_at    BEFORE UPDATE ON app.debts    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER legal_updated_at    BEFORE UPDATE ON app.legal_cases FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();
CREATE TRIGGER rules_updated_at    BEFORE UPDATE ON app.follow_up_rules FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- New debt starts with outstanding = original (unless given).
CREATE OR REPLACE FUNCTION app.debts_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_outstanding IS NULL THEN
    NEW.amount_outstanding := NEW.amount_original;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER debts_defaults BEFORE INSERT OR UPDATE ON app.debts
  FOR EACH ROW EXECUTE FUNCTION app.debts_defaults();

-- When a payment is approved (or un-approved), recalculate the balance.
-- Reaching zero sets the debt to 'paid' and cancels pending reminders:
-- the "paid" stop rule is enforced by the database, not only the app.
CREATE OR REPLACE FUNCTION app.recalc_debt_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debt_id uuid := coalesce(NEW.debt_id, OLD.debt_id);
  v_paid numeric(12,2);
  v_new_outstanding numeric(12,2);
BEGIN
  SELECT coalesce(sum(amount), 0) INTO v_paid
  FROM app.payments WHERE debt_id = v_debt_id AND status = 'approved';

  UPDATE app.debts d
     SET amount_outstanding = greatest(d.amount_original - v_paid, 0),
         status = CASE
                    WHEN d.amount_original - v_paid <= 0 THEN 'paid'
                    WHEN v_paid > 0 AND d.status IN ('open','in_follow_up','promised','paid') THEN 'partly_paid'
                    WHEN v_paid = 0 AND d.status IN ('paid','partly_paid') THEN 'in_follow_up'
                    ELSE d.status
                  END
   WHERE d.id = v_debt_id
   RETURNING amount_outstanding INTO v_new_outstanding;

  IF v_new_outstanding = 0 THEN
    UPDATE app.follow_up_tasks
       SET status = 'cancelled', skip_reason = 'debt_paid'
     WHERE debt_id = v_debt_id AND status = 'pending';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER payments_recalc
  AFTER INSERT OR DELETE OR UPDATE OF status, amount ON app.payments
  FOR EACH ROW EXECUTE FUNCTION app.recalc_debt_balance();

-- A new open dispute pauses the debt and cancels pending reminders.
CREATE OR REPLACE FUNCTION app.on_dispute_opened() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'open' THEN
    UPDATE app.debts SET status = 'disputed' WHERE id = NEW.debt_id;
    UPDATE app.follow_up_tasks SET status = 'cancelled', skip_reason = 'disputed'
     WHERE debt_id = NEW.debt_id AND status = 'pending';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER disputes_opened AFTER INSERT ON app.disputes
  FOR EACH ROW EXECUTE FUNCTION app.on_dispute_opened();

-- =====================================================================
-- 11. DASHBOARD VIEWS (security_invoker = RLS still applies)
-- =====================================================================

CREATE VIEW app.v_debt_overview WITH (security_invoker = true) AS
SELECT d.client_id,
       d.id                AS debt_id,
       d.ref_code,
       dr.id               AS debtor_id,
       dr.full_name,
       d.amount_original,
       d.amount_outstanding,
       d.status,
       d.attempts_count,
       d.last_contact_at,
       d.last_reply_at,
       coalesce(it.code, 'none')                  AS instrument_type,
       coalesce(it.directly_enforceable, false)   AS directly_enforceable,
       i.enforceable_until
FROM app.debts d
JOIN app.debtors dr ON dr.client_id = d.client_id AND dr.id = d.debtor_id
LEFT JOIN app.instruments i ON i.client_id = d.client_id AND i.id = d.instrument_id
LEFT JOIN app.instrument_types it ON it.code = i.type_code;

-- The main numbers for the dashboard (section 13 of the brief).
CREATE VIEW app.v_client_totals WITH (security_invoker = true) AS
SELECT client_id,
       sum(amount_original)                                                   AS total_owed,
       sum(amount_original - amount_outstanding)                              AS recovered,
       sum(amount_outstanding) FILTER (WHERE status = 'promised')             AS promised,
       sum(amount_outstanding) FILTER (WHERE status = 'disputed')             AS disputed,
       sum(amount_outstanding) FILTER (WHERE status IN ('legal_ready','in_legal')) AS in_legal,
       sum(amount_outstanding) FILTER (WHERE status NOT IN ('paid','closed','written_off')) AS open_balance,
       round(100.0 * coalesce(sum(amount_outstanding) FILTER (WHERE directly_enforceable
                                  AND status NOT IN ('paid','closed','written_off')), 0)
             / nullif(sum(amount_outstanding) FILTER (WHERE status NOT IN ('paid','closed','written_off')), 0), 1)
                                                                              AS enforceable_share_pct,
       count(*) FILTER (WHERE instrument_type = 'paper_promissory_note'
                        AND status NOT IN ('paid','closed','written_off'))    AS paper_notes_at_risk
FROM app.v_debt_overview
GROUP BY client_id;

-- =====================================================================
-- 12. ROW LEVEL SECURITY
-- =====================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','follow_up_rules','debtors','debtor_phones','instruments','debts',
                           'documents','imports','messages','follow_up_tasks','promises','disputes',
                           'payment_links','payments','legal_cases','notifications']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I
                    USING (client_id = app.current_client_id())
                    WITH CHECK (client_id = app.current_client_id())', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['document_chunks','agent_runs']
  LOOP
    EXECUTE format('ALTER TABLE ai.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON ai.%I
                    USING (client_id = app.current_client_id())
                    WITH CHECK (client_id = app.current_client_id())', t);
  END LOOP;
END $$;

-- Clients can read their own audit trail. The audit trigger writes as the
-- table owner, so it is not blocked by this.
ALTER TABLE audit.activity_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.activity_log
  USING (client_id = app.current_client_id())
  WITH CHECK (client_id = app.current_client_id());

ALTER TABLE app.clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.clients
  USING (id = app.current_client_id()) WITH CHECK (id = app.current_client_id());

-- Talos templates (client_id null) are readable by everyone, editable by nobody in the app.
ALTER TABLE app.message_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY read_own_and_default ON app.message_templates FOR SELECT
  USING (client_id IS NULL OR client_id = app.current_client_id());
CREATE POLICY write_own ON app.message_templates FOR ALL
  USING (client_id = app.current_client_id()) WITH CHECK (client_id = app.current_client_id());

-- =====================================================================
-- 13. ROLES
--   talos_app     used by the web app and API. RLS applies.
--   talos_worker  used by the scheduler and webhook handlers, which must
--                 see all clients, through the worker_all policies in
--                 0003 (not BYPASSRLS), so keep this code small.
--   Migrations run as the database owner (not either of these).
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talos_app') THEN
    CREATE ROLE talos_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talos_worker') THEN
    CREATE ROLE talos_worker NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA app, ai TO talos_app, talos_worker;
GRANT USAGE ON SCHEMA audit TO talos_app, talos_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app, ai TO talos_app, talos_worker;
GRANT SELECT, INSERT ON audit.activity_log TO talos_app, talos_worker;   -- no UPDATE / DELETE
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO talos_app, talos_worker;
-- Reference data is read-only for the app.
REVOKE INSERT, UPDATE, DELETE ON app.instrument_types, app.sender_numbers FROM talos_app;
-- Raw webhooks are only for the worker.
REVOKE ALL ON app.webhook_events FROM talos_app;
-- Login users (talos_api, talos_jobs) are created by db/roles/login_roles.sql.

-- =====================================================================
-- 14. SEED: Najiz instrument types (from the Najiz screenshots)
-- =====================================================================

INSERT INTO app.instrument_types (code, name_en, name_ar, najiz_main_type, najiz_sub_type, directly_enforceable, has_time_limit, sort_order) VALUES
 ('nafith_promissory_note',   'Promissory note on Nafith',           'سند لأمر إلكتروني (نافذ)', 'أوراق تجارية', 'سند لأمر', true,  false, 10),
 ('paper_promissory_note',    'Paper promissory note',               'سند لأمر ورقي',            'أوراق تجارية', 'سند لأمر', true,  true,  20),
 ('cheque',                   'Cheque',                              'شيك',                      'أوراق تجارية', 'شيك',     true,  false, 30),
 ('bill_of_exchange',         'Bill of exchange',                    'كمبيالة',                  'أوراق تجارية', 'كمبيالة', true,  true,  40),
 ('court_judgment',           'Court judgment, decision or order',   'حكم قضائي',                'أحكام وقرارات', 'حكم أو قرار أو أمر قضائي', true, false, 50),
 ('labor_judgment',           'Labor court judgment',                'حكم عمالي',                'أحكام وقرارات', 'حكم من المحاكم أو الدوائر العمالية', true, false, 60),
 ('quasi_judicial_decision',  'Quasi-judicial committee decision',   NULL,                       'أحكام وقرارات', NULL, true, false, 70),
 ('arbitration_award',        'Arbitration award with execution order', 'حكم تحكيم',             'أحكام وقرارات', NULL, true, false, 80),
 ('foreign_judgment',         'Foreign court judgment or order',     NULL,                       'أحكام وقرارات', NULL, true, false, 90),
 ('foreign_arbitration_award','Foreign arbitration award',           NULL,                       'أحكام وقرارات', NULL, true, false, 100),
 ('settlement_record_taradhi','Settlement record (Taradhi)',          'محضر صلح (تراضي)',         'محاضر', NULL, true, false, 110),
 ('settlement_record_court',  'Settlement record approved by court', 'محضر صلح مصدق من المحكمة', 'محاضر', NULL, true, false, 120),
 ('notarized_contract',       'Notarized contract or document',      'عقد موثق',                 'عقود', NULL, true, false, 130),
 ('other_executive_contract', 'Other contract with executive force by law', NULL,                'عقود', NULL, true, false, 140),
 ('ejar_lease',               'Unified Ejar lease contract',         'عقد إيجار موحد (إيجار)',   'عقود', NULL, true, false, 150),
 ('foreign_notarized_document','Foreign notarized document',         NULL,                       'أخرى', NULL, true, false, 160),
 ('plain_contract',           'Ordinary contract (lawsuit needed first)', 'عقد غير موثق',       NULL, NULL, false, false, 900),
 ('invoice',                  'Invoice only (lawsuit needed first)', 'فاتورة',                   NULL, NULL, false, false, 910);
-- A debt with instrument_id = null means "no instrument".
