-- =====================================================================
-- Safety checks for the database rules. Run after dev/seed.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f dev/checks.sql
-- Everything runs in one transaction and is rolled back at the end,
-- so the seed data is left unchanged. Any failed check stops the run
-- with an error naming the check.
-- =====================================================================

\set QUIET on
BEGIN;

-- A second fake client, used to prove one client can never see another's data.
INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Other Demo Client', '0000000002',
        'Other Owner', '+966500000200', 'other@demo.example', 'active');
INSERT INTO app.debtors (client_id, ref_code, id_type, id_number, full_name)
VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'D-OTHER-1', 'iqama', '2999999999', 'Other Client Debtor');

-- ---------------------------------------------------------------------
-- 1. Tenant isolation (Row Level Security) as the API role
-- ---------------------------------------------------------------------
SET LOCAL ROLE talos_app;
SET LOCAL app.client_id = '11111111-1111-4111-8111-111111111111';

DO $$
BEGIN
  ASSERT (SELECT count(*) FROM app.debtors) = 5,
    'CHECK 1a FAILED: client should see exactly its own 5 debtors';
  ASSERT NOT EXISTS (SELECT 1 FROM app.debtors WHERE full_name = 'Other Client Debtor'),
    'CHECK 1b FAILED: client can see another client''s debtor';
  ASSERT (SELECT count(*) FROM app.clients) = 1,
    'CHECK 1c FAILED: client should see only its own client row';
  RAISE NOTICE 'PASS 1: a client only sees its own data';
END $$;

-- Writing a row for another client must be refused.
DO $$
BEGIN
  BEGIN
    INSERT INTO app.debtors (client_id, ref_code, id_type, id_number, full_name)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'D-HACK', 'iqama', '2888888888', 'Should Fail');
    RAISE EXCEPTION 'CHECK 2 FAILED: inserted a row for another client';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS 2: writing another client''s data is refused';
  END;
END $$;

-- With no client set, nothing is visible.
SET LOCAL app.client_id = '';
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM app.debts) = 0,
    'CHECK 3 FAILED: data visible with no client set';
  RAISE NOTICE 'PASS 3: no client set means no data';
END $$;

-- Back to the demo client for the remaining checks.
SET LOCAL app.client_id = '11111111-1111-4111-8111-111111111111';

-- ---------------------------------------------------------------------
-- 4. A payment cannot be approved without a reviewer
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE app.payments SET status = 'approved'
     WHERE debt_id = '66666666-6666-4666-8666-000000000003' AND status = 'pending_approval';
    RAISE EXCEPTION 'CHECK 4 FAILED: payment approved without a reviewer';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 4: approval requires a reviewer';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 5. Approving a partial payment reduces the balance (Rahim, 2100 - 1000)
-- ---------------------------------------------------------------------
SET LOCAL app.user_id = '22222222-2222-4222-8222-000000000002';
UPDATE app.payments
   SET status = 'approved', reviewed_by = '22222222-2222-4222-8222-000000000002', reviewed_at = now()
 WHERE debt_id = '66666666-6666-4666-8666-000000000003' AND status = 'pending_approval';
DO $$
BEGIN
  ASSERT (SELECT amount_outstanding FROM app.debts WHERE id = '66666666-6666-4666-8666-000000000003') = 1100.00,
    'CHECK 5a FAILED: balance should be 1100.00 after approving 1000.00';
  ASSERT (SELECT status FROM app.debts WHERE id = '66666666-6666-4666-8666-000000000003') = 'partly_paid',
    'CHECK 5b FAILED: debt should be partly_paid';
  RAISE NOTICE 'PASS 5: approved payment reduces the balance';
END $$;

-- ---------------------------------------------------------------------
-- 6. Paying the rest marks the debt paid and cancels pending reminders
-- ---------------------------------------------------------------------
INSERT INTO app.payments (client_id, debt_id, amount, method, status, reviewed_by, reviewed_at)
VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000003', 1100.00,
        'bank_transfer', 'approved', '22222222-2222-4222-8222-000000000002', now());
DO $$
BEGIN
  ASSERT (SELECT status FROM app.debts WHERE id = '66666666-6666-4666-8666-000000000003') = 'paid',
    'CHECK 6a FAILED: debt should be paid';
  ASSERT (SELECT amount_outstanding FROM app.debts WHERE id = '66666666-6666-4666-8666-000000000003') = 0,
    'CHECK 6b FAILED: balance should be zero';
  ASSERT NOT EXISTS (SELECT 1 FROM app.follow_up_tasks
                      WHERE debt_id = '66666666-6666-4666-8666-000000000003' AND status = 'pending'),
    'CHECK 6c FAILED: reminders still pending for a paid debt';
  RAISE NOTICE 'PASS 6: paid debt stops its reminders';
END $$;

-- ---------------------------------------------------------------------
-- 7. A new dispute pauses the debt and cancels pending reminders (Imran)
-- ---------------------------------------------------------------------
INSERT INTO app.disputes (client_id, debt_id, reason)
VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000001', 'Check: debtor disputes');
DO $$
BEGIN
  ASSERT (SELECT status FROM app.debts WHERE id = '66666666-6666-4666-8666-000000000001') = 'disputed',
    'CHECK 7a FAILED: debt should be disputed';
  ASSERT NOT EXISTS (SELECT 1 FROM app.follow_up_tasks
                      WHERE debt_id = '66666666-6666-4666-8666-000000000001' AND status = 'pending'),
    'CHECK 7b FAILED: reminders still pending for a disputed debt';
  RAISE NOTICE 'PASS 7: dispute stops reminders';
END $$;

-- ---------------------------------------------------------------------
-- 8. Every change is logged, and the log cannot be edited or deleted
-- ---------------------------------------------------------------------
DO $$
BEGIN
  ASSERT EXISTS (SELECT 1 FROM audit.activity_log
                  WHERE action = 'payments.update' AND actor_type = 'user'
                    AND actor_id = '22222222-2222-4222-8222-000000000002'),
    'CHECK 8a FAILED: payment approval was not logged with the reviewer';
  BEGIN
    DELETE FROM audit.activity_log;
    RAISE EXCEPTION 'CHECK 8b FAILED: audit log rows were deleted';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    IF SQLERRM LIKE 'CHECK 8b FAILED%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS 8: changes are logged and the log is protected';
END $$;

-- ---------------------------------------------------------------------
-- 9. A legal case cannot move forward without human approval
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO app.legal_cases (client_id, debt_id, amount_claimed, status)
    VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000005', 1000.00, 'submitted');
    RAISE EXCEPTION 'CHECK 9 FAILED: legal case submitted without approval';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 9: legal case needs approval first';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 10. The API role cannot read raw webhooks or change reference data
-- ---------------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM app.webhook_events LIMIT 1;
    RAISE EXCEPTION 'CHECK 10a FAILED: API role can read raw webhooks';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE app.instrument_types SET directly_enforceable = false WHERE code = 'cheque';
    RAISE EXCEPTION 'CHECK 10b FAILED: API role changed instrument types';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS 10: API role is limited correctly';
END $$;

ROLLBACK;
\echo 'All database checks passed.'
