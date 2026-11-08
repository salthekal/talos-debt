-- =====================================================================
-- 0005: the scheduler (Phase 2)
--
--   1. Staff approval of reminders when a client has auto_send = false.
--   2. Retries and the last error for each task, so a failed send is
--      visible and is not retried forever.
--   3. At most one open reminder task and one open legal task per debt,
--      enforced by the database, so two workers (or a worker and a
--      person) can never plan the same reminder twice.
--   4. A fast lookup of a client's open tasks for one debt.
-- =====================================================================

ALTER TABLE app.follow_up_tasks
  ADD COLUMN approved_by  uuid,                         -- staff member who approved the send (auto_send = false)
  ADD COLUMN approved_at  timestamptz,
  ADD COLUMN tries        int NOT NULL DEFAULT 0 CHECK (tries >= 0),  -- send attempts for this task
  ADD COLUMN last_error   text,
  ADD COLUMN finished_at  timestamptz,
  ADD FOREIGN KEY (client_id, approved_by) REFERENCES app.users (client_id, id),
  ADD CONSTRAINT follow_up_tasks_approval_pair
      CHECK ((approved_by IS NULL) = (approved_at IS NULL));

-- One open (pending or running) reminder and one open legal step per debt.
-- Promise checks are left out: a debtor can make a new promise before the
-- old one is checked, and the check itself sorts out which one counts.
CREATE UNIQUE INDEX follow_up_tasks_one_open
  ON app.follow_up_tasks (client_id, debt_id, task_type)
  WHERE status IN ('pending', 'running') AND task_type IN ('send_reminder', 'mark_legal_ready');

CREATE INDEX follow_up_tasks_by_debt ON app.follow_up_tasks (client_id, debt_id, created_at DESC);

-- Tasks the worker left in 'running' (for example after a crash) are found by this.
CREATE INDEX follow_up_tasks_running ON app.follow_up_tasks (locked_at) WHERE status = 'running';
