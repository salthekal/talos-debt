-- =====================================================================
-- 0004: getting data in (Phase 3)
--
--   1. Reference numbers made by the database, per client, without gaps
--      caused by races: debtors D-000001, debts DBT-2026-0001.
--   2. Excel imports keep their check report (errors and warnings),
--      the parsed rows until they are confirmed, and who confirmed them.
--   3. One instrument record per debtor + type + reference number, so a
--      promissory note that backs several debts is stored once.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Reference counters
-- ---------------------------------------------------------------------
CREATE TABLE app.ref_counters (
  client_id   uuid   NOT NULL REFERENCES app.clients(id),
  prefix      text   NOT NULL,          -- 'D-' or 'DBT-2026-'
  last_value  bigint NOT NULL CHECK (last_value >= 0),
  PRIMARY KEY (client_id, prefix)
);

ALTER TABLE app.ref_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.ref_counters
  USING (client_id = app.current_client_id())
  WITH CHECK (client_id = app.current_client_id());
-- Every table with RLS also needs the worker policy (see 0003).
CREATE POLICY worker_all ON app.ref_counters TO talos_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON app.ref_counters TO talos_app, talos_worker;

-- Next free reference for the current client.
--   p_kind = 'debtor' -> D-000001
--   p_kind = 'debt'   -> DBT-<year in Riyadh>-0001
-- The counter row is locked while it is updated, so two requests never
-- get the same number. On first use it starts after the highest existing
-- reference with the same prefix (for example the seed data), and it
-- skips any number a person already typed by hand.
CREATE OR REPLACE FUNCTION app.next_ref(p_kind text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_client uuid := app.current_client_id();
  v_prefix text;
  v_width  int;
  v_start  bigint;
  v_next   bigint;
  v_ref    text;
  v_taken  boolean;
BEGIN
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'app.client_id is not set';
  END IF;

  IF p_kind = 'debtor' THEN
    v_prefix := 'D-';
    v_width  := 6;
  ELSIF p_kind = 'debt' THEN
    v_prefix := 'DBT-' || to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY') || '-';
    v_width  := 4;
  ELSE
    RAISE EXCEPTION 'unknown reference kind: %', p_kind;
  END IF;

  LOOP
    UPDATE app.ref_counters SET last_value = last_value + 1
     WHERE client_id = v_client AND prefix = v_prefix
     RETURNING last_value INTO v_next;

    IF NOT FOUND THEN
      IF p_kind = 'debtor' THEN
        SELECT coalesce(max(substring(ref_code FROM length(v_prefix) + 1)::bigint), 0) INTO v_start
          FROM app.debtors
         WHERE client_id = v_client AND ref_code ~ ('^' || v_prefix || '[0-9]{1,15}$');
      ELSE
        SELECT coalesce(max(substring(ref_code FROM length(v_prefix) + 1)::bigint), 0) INTO v_start
          FROM app.debts
         WHERE client_id = v_client AND ref_code ~ ('^' || v_prefix || '[0-9]{1,15}$');
      END IF;
      INSERT INTO app.ref_counters (client_id, prefix, last_value)
      VALUES (v_client, v_prefix, v_start + 1)
      ON CONFLICT (client_id, prefix) DO UPDATE SET last_value = app.ref_counters.last_value + 1
      RETURNING last_value INTO v_next;
    END IF;

    -- lpad would cut long numbers, so only pad when shorter.
    v_ref := v_prefix || CASE WHEN length(v_next::text) >= v_width THEN v_next::text
                              ELSE lpad(v_next::text, v_width, '0') END;

    IF p_kind = 'debtor' THEN
      SELECT EXISTS (SELECT 1 FROM app.debtors WHERE client_id = v_client AND ref_code = v_ref) INTO v_taken;
    ELSE
      SELECT EXISTS (SELECT 1 FROM app.debts WHERE client_id = v_client AND ref_code = v_ref) INTO v_taken;
    END IF;
    EXIT WHEN NOT v_taken;
  END LOOP;

  RETURN v_ref;
END $$;

GRANT EXECUTE ON FUNCTION app.next_ref(text) TO talos_app, talos_worker;

-- ---------------------------------------------------------------------
-- 2. Excel imports: check report and parsed rows
-- ---------------------------------------------------------------------
ALTER TABLE app.imports
  ADD COLUMN warnings     jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN summary      jsonb NOT NULL DEFAULT '{}',
  -- Parsed rows, kept only until the import is confirmed or cancelled,
  -- so debtor data is not stored twice.
  ADD COLUMN rows         jsonb,
  ADD COLUMN confirmed_by uuid,
  ADD COLUMN confirmed_at timestamptz,
  ADD FOREIGN KEY (client_id, confirmed_by) REFERENCES app.users (client_id, id),
  ADD CONSTRAINT imports_rows_cleared
      CHECK (status IN ('validating', 'ready', 'failed') OR rows IS NULL),
  ADD CONSTRAINT imports_confirmed
      CHECK (status <> 'imported' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL));

CREATE INDEX imports_recent ON app.imports (client_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 3. One record per instrument
-- ---------------------------------------------------------------------
-- Reference numbers are compared without spaces and in upper case.
CREATE UNIQUE INDEX instruments_one_per_reference
  ON app.instruments (client_id, debtor_id, type_code, upper(replace(reference_number, ' ', '')))
  WHERE reference_number IS NOT NULL;

CREATE INDEX instruments_by_debtor ON app.instruments (client_id, debtor_id);
CREATE INDEX debts_by_instrument ON app.debts (client_id, instrument_id) WHERE instrument_id IS NOT NULL;
