-- =====================================================================
-- 0009: Najiz runs (Phase 5.4 and 5.5)
--
-- A run is one sign-in to Najiz for one client, approved by the owner in
-- Nafath, that files one or more approved notes (kind 'file') or reads the
-- status of filed requests (kind 'status_check'). The Najiz worker
-- (`npm run najiz`) claims a run, drives the browser, and writes its
-- progress here so the dashboard can show it.
--
-- Najiz rule 3: nothing about the Najiz session is stored. The browser
-- session lives only in the worker's memory and is closed when the run
-- ends. This table holds the two-digit Nafath number while it is shown
-- (it is useless after the sign-in), progress, and the results.
-- Najiz rule 4: runs are deleted with their client (ON DELETE CASCADE).
-- Najiz rule 5: changes are written to the audit log by its trigger.
-- =====================================================================

CREATE TABLE app.najiz_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES app.clients(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('file', 'status_check')),
  stage             text NOT NULL DEFAULT 'starting'
                    CHECK (stage IN ('starting', 'waiting_nafath', 'working', 'done', 'stopped', 'expired')),
  requested_by      uuid NOT NULL,
  nafath_number     text CHECK (nafath_number ~ '^[0-9]{1,3}$'),
  nafath_expires_at timestamptz,
  stop_reason       text CHECK (stop_reason IN ('unexpected_page', 'captcha', 'najiz_error', 'details_differ',
                                                'company_not_found', 'cancelled', 'worker_lost')),
  stop_detail       text,                 -- for staff, in plain words; never session data
  claimed_by        text,                 -- which worker process has it
  heartbeat_at      timestamptz,          -- the worker writes this while it works
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  UNIQUE (client_id, id),
  FOREIGN KEY (client_id, requested_by) REFERENCES app.users (client_id, id),
  -- The Nafath number is only kept while the owner is asked to choose it.
  CHECK (nafath_number IS NULL OR stage = 'waiting_nafath'),
  CHECK ((stage IN ('done', 'stopped', 'expired')) = (finished_at IS NOT NULL))
);

-- One Najiz sign-in at a time per client.
CREATE UNIQUE INDEX najiz_runs_one_active ON app.najiz_runs (client_id)
  WHERE stage IN ('starting', 'waiting_nafath', 'working');
-- The worker looks for new runs and for runs whose worker stopped answering.
CREATE INDEX najiz_runs_active ON app.najiz_runs (stage, created_at) WHERE stage IN ('starting', 'waiting_nafath', 'working');

CREATE TABLE app.najiz_run_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL,
  run_id          uuid NOT NULL,
  legal_case_id   uuid NOT NULL,
  position        int NOT NULL CHECK (position >= 0),
  step            text NOT NULL DEFAULT 'waiting'
                  CHECK (step IN ('waiting', 'request_type', 'requester', 'debtor', 'content', 'sending',
                                  'sent', 'checked', 'stopped')),
  request_number  text CHECK (request_number ~ '^[0-9]{6,20}$'),
  najiz_status    text,                  -- read from Najiz (status checks)
  error           text,                  -- for staff, in plain words
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, id),
  UNIQUE (run_id, legal_case_id),
  FOREIGN KEY (client_id, run_id) REFERENCES app.najiz_runs (client_id, id) ON DELETE CASCADE,
  FOREIGN KEY (client_id, legal_case_id) REFERENCES app.legal_cases (client_id, id) ON DELETE CASCADE
);
CREATE INDEX najiz_run_items_by_run ON app.najiz_run_items (client_id, run_id, position);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['najiz_runs', 'najiz_run_items']
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON app.%I
                    USING (client_id = app.current_client_id())
                    WITH CHECK (client_id = app.current_client_id())', t);
    -- Every table with RLS also needs the worker policy (see 0003).
    EXECUTE format('CREATE POLICY worker_all ON app.%I TO talos_worker USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON app.%I TO talos_app, talos_worker', t);
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION audit.log_change()', t, t);
  END LOOP;
END $$;
