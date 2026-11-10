-- =====================================================================
-- 0008: the data Najiz asks for when a client files a promissory note
-- for execution (Phase 5), taken from Sal's screen recordings of the
-- Najiz Business filing steps.
--
--   1. Client: the owner's ID number (Nafath sign-in), the unified
--      establishment number (starts with 7), and how the owner acts for
--      the company on Najiz (legal representative for now).
--   2. Debtor: the name in parts, as written on the iqama or ID.
--   3. Note: where it was written (country and city). Najiz also asks
--      for the place of payment; Sal decided it is the same place, and
--      the client gives it for each note. Due on a date or on demand.
--   4. Legal case: what Najiz shows after filing (circuit, status, date
--      submitted), the amount already received, and the owner's email
--      and mobile as confirmed by the client when approving the filing.
--      One open request per note, as one note is one Najiz request.
--   5. Status history of each legal case (entered by hand at first,
--      later read from Najiz).
--   6. Two document types: partners' decisions (optional on Najiz) and
--      the Najiz receipt (the success page, kept as proof).
--
-- Every new column may be empty, so existing rows and code keep working.
-- Nothing here stores Najiz or Nafath passwords or session data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Client
-- ---------------------------------------------------------------------
ALTER TABLE app.clients
  ADD COLUMN owner_id_type        text CHECK (owner_id_type IN ('national_id', 'iqama')),
  ADD COLUMN owner_id_number      text CHECK (owner_id_number ~ '^[12][0-9]{9}$'),
  ADD COLUMN unified_number       text CHECK (unified_number ~ '^7[0-9]{9}$'),
  ADD COLUMN najiz_representation text NOT NULL DEFAULT 'legal_representative'
                                  CHECK (najiz_representation IN ('legal_representative')),
  -- A national ID starts with 1 and an iqama with 2; the type must match the number.
  ADD CONSTRAINT clients_owner_id_pair CHECK (
        (owner_id_type IS NULL) = (owner_id_number IS NULL)
    AND (owner_id_type IS NULL
         OR (owner_id_type = 'national_id' AND owner_id_number LIKE '1%')
         OR (owner_id_type = 'iqama'       AND owner_id_number LIKE '2%')));

-- ---------------------------------------------------------------------
-- 2. Debtor name in parts (Najiz step 3). full_name stays as it is.
-- ---------------------------------------------------------------------
ALTER TABLE app.debtors
  ADD COLUMN first_name       text CHECK (btrim(first_name) <> ''),
  ADD COLUMN father_name      text CHECK (btrim(father_name) <> ''),       -- optional on Najiz
  ADD COLUMN grandfather_name text CHECK (btrim(grandfather_name) <> ''),  -- optional on Najiz
  ADD COLUMN family_name      text CHECK (btrim(family_name) <> '');

-- ---------------------------------------------------------------------
-- 3. Note details (Najiz step 4)
-- ---------------------------------------------------------------------
ALTER TABLE app.instruments
  ADD COLUMN issue_country  char(2) CHECK (issue_country ~ '^[A-Z]{2}$'),  -- ISO code, usually SA
  ADD COLUMN issue_city     text CHECK (btrim(issue_city) <> ''),           -- also the place of payment
  ADD COLUMN due_on_demand  boolean NOT NULL DEFAULT false;                 -- true: "لدى الإطلاع / تحت الطلب"

-- ---------------------------------------------------------------------
-- 4. Legal case: what was filed and what Najiz says
-- ---------------------------------------------------------------------
ALTER TABLE app.legal_cases
  ADD COLUMN amount_received        numeric(12,2) NOT NULL DEFAULT 0 CHECK (amount_received >= 0),
  ADD COLUMN contact_email          citext,      -- owner's email, confirmed by the client at approval
  ADD COLUMN contact_phone          text CHECK (contact_phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN najiz_circuit          text,        -- for example "دائرة التنفيذ الثالثة"
  ADD COLUMN najiz_status           text,        -- the status exactly as Najiz shows it
  ADD COLUMN najiz_status_checked_at timestamptz,
  ADD CONSTRAINT legal_cases_request_number_format
      CHECK (najiz_request_number ~ '^[0-9]{6,20}$'),
  -- A request number exists only once the case was submitted.
  ADD CONSTRAINT legal_cases_number_after_submit
      CHECK (najiz_request_number IS NULL
             OR status IN ('submitted','order_issued','measures_applied','settled','closed','withdrawn'));

-- One Najiz request per note: a note cannot back two open cases.
CREATE UNIQUE INDEX legal_cases_one_open_per_instrument
  ON app.legal_cases (client_id, instrument_id)
  WHERE instrument_id IS NOT NULL AND status NOT IN ('closed','withdrawn','settled');

-- A request number is never used twice by the same client.
CREATE UNIQUE INDEX legal_cases_request_number_unique
  ON app.legal_cases (client_id, najiz_request_number)
  WHERE najiz_request_number IS NOT NULL;

-- ---------------------------------------------------------------------
-- 5. Status history
-- ---------------------------------------------------------------------
CREATE TABLE app.legal_case_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL,
  legal_case_id  uuid NOT NULL,
  status         text NOT NULL
                 CHECK (status IN ('ready','approved','submitted','order_issued','measures_applied',
                                   'settled','closed','withdrawn')),
  najiz_status   text,                    -- as Najiz shows it, when read from Najiz
  note           text,                    -- staff note, in their words
  source         text NOT NULL CHECK (source IN ('staff','najiz_filing','najiz_check')),
  recorded_by    uuid,                    -- staff member, when entered by hand
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, legal_case_id) REFERENCES app.legal_cases (client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, recorded_by)   REFERENCES app.users (client_id, id),
  CHECK (source <> 'staff' OR recorded_by IS NOT NULL)
);
CREATE INDEX legal_case_events_by_case ON app.legal_case_events (client_id, legal_case_id, recorded_at DESC);

ALTER TABLE app.legal_case_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.legal_case_events
  USING (client_id = app.current_client_id())
  WITH CHECK (client_id = app.current_client_id());
-- Every table with RLS also needs the worker policy (see 0003).
CREATE POLICY worker_all ON app.legal_case_events TO talos_worker USING (true) WITH CHECK (true);
-- History is added to, never changed. Removing it happens only through the
-- legal case (ON DELETE CASCADE), for example when a client account is deleted.
GRANT SELECT, INSERT ON app.legal_case_events TO talos_app, talos_worker;

CREATE TRIGGER legal_case_events_audit AFTER INSERT OR UPDATE OR DELETE ON app.legal_case_events
  FOR EACH ROW EXECUTE FUNCTION audit.log_change();

-- ---------------------------------------------------------------------
-- 6. Document types
-- ---------------------------------------------------------------------
ALTER TABLE app.documents DROP CONSTRAINT documents_doc_type_check;
ALTER TABLE app.documents ADD CONSTRAINT documents_doc_type_check CHECK (doc_type IN (
  'cr','establishment_contract','partners_decision','iban_letter','authorization',   -- client
  'national_id','iqama','employment_contract',                                       -- debtor
  'promissory_note','cheque','judgment','contract','invoice',
  'receipt','payment_proof','legal_pack','najiz_receipt','import_file','other'));
