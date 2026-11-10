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

-- ---------------------------------------------------------------------
-- 11. Inbound WhatsApp messages open the 24-hour reply window
-- ---------------------------------------------------------------------
DO $$
BEGIN
  -- Fahad replied 1 day ago in the seed, so his window is closed.
  ASSERT NOT app.whatsapp_window_open('44444444-4444-4444-8444-000000000003'),
    'CHECK 11a FAILED: window should be closed after more than 24 hours';
  INSERT INTO app.messages (client_id, debtor_id, debt_id, phone_id, channel, direction, body, status)
  VALUES ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000002',
          '66666666-6666-4666-8666-000000000002', '44444444-4444-4444-8444-000000000003',
          'whatsapp', 'inbound', 'Check: new message', 'received');
  ASSERT app.whatsapp_window_open('44444444-4444-4444-8444-000000000003'),
    'CHECK 11b FAILED: window should open after a new inbound message';
  -- Rahim replied 6 hours ago in the seed (filled from history).
  ASSERT app.whatsapp_window_open('44444444-4444-4444-8444-000000000004'),
    'CHECK 11c FAILED: window should be open for a reply 6 hours ago';
  RAISE NOTICE 'PASS 11: inbound messages open the 24-hour window';
END $$;

-- ---------------------------------------------------------------------
-- 12. Reference numbers are per client, in order, and skip used ones
-- ---------------------------------------------------------------------
SET LOCAL app.client_id = '11111111-1111-4111-8111-111111111111';
DO $$
DECLARE v_year text := to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY');
BEGIN
  -- The seed has D-000001 to D-000005.
  ASSERT app.next_ref('debtor') = 'D-000006', 'CHECK 12a FAILED: first debtor reference should follow the seed';
  ASSERT app.next_ref('debtor') = 'D-000007', 'CHECK 12b FAILED: references should go up by one';
  INSERT INTO app.debtors (client_id, ref_code, id_type, id_number, full_name)
  VALUES ('11111111-1111-4111-8111-111111111111', 'D-000008', 'iqama', '2000000099', 'Typed By Hand');
  ASSERT app.next_ref('debtor') = 'D-000009', 'CHECK 12c FAILED: a reference typed by hand should be skipped';
  -- The seed debts are DBT-2026-0001 to 0005.
  ASSERT app.next_ref('debt') = 'DBT-' || v_year || '-' || CASE WHEN v_year = '2026' THEN '0006' ELSE '0001' END,
    'CHECK 12d FAILED: debt references should follow the seed for the year';
  PERFORM set_config('app.client_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  ASSERT app.next_ref('debtor') = 'D-000001', 'CHECK 12e FAILED: each client should have its own numbering';
  PERFORM set_config('app.client_id', '11111111-1111-4111-8111-111111111111', true);
  RAISE NOTICE 'PASS 12: reference numbers are per client and never repeat';
END $$;

-- ---------------------------------------------------------------------
-- 13. One instrument record per debtor, type and reference number
-- ---------------------------------------------------------------------
DO $$
BEGIN
  INSERT INTO app.instruments (client_id, debtor_id, type_code, reference_number)
  VALUES ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000002',
          'nafith_promissory_note', 'NF-123 456');
  BEGIN
    INSERT INTO app.instruments (client_id, debtor_id, type_code, reference_number)
    VALUES ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000002',
            'nafith_promissory_note', 'nf-123456');
    RAISE EXCEPTION 'CHECK 13 FAILED: the same note was stored twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS 13: a note that backs several debts is stored once';
  END;
END $$;

-- ---------------------------------------------------------------------
-- 14. Najiz filing data (0008)
-- ---------------------------------------------------------------------
DO $$
DECLARE v_case uuid;
BEGIN
  -- The owner ID type must match the number (national ID starts with 1, iqama with 2).
  BEGIN
    UPDATE app.clients SET owner_id_type = 'iqama', owner_id_number = '1000000100'
     WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'CHECK 14a FAILED: an iqama type with a national ID number was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE app.clients SET unified_number = '4030000000' WHERE id = '11111111-1111-4111-8111-111111111111';
    RAISE EXCEPTION 'CHECK 14b FAILED: a unified number not starting with 7 was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- One open Najiz request per note: the seed note NAFITH-DEMO-0001 backs Imran's debt.
  INSERT INTO app.legal_cases (client_id, debt_id, instrument_id, amount_claimed)
  VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000001',
          '55555555-5555-4555-8555-000000000001', 3450.00)
  RETURNING id INTO v_case;
  BEGIN
    INSERT INTO app.debts (id, client_id, debtor_id, instrument_id, ref_code, amount_original, reason)
    VALUES ('66666666-6666-4666-8666-0000000000aa', '11111111-1111-4111-8111-111111111111',
            '33333333-3333-4333-8333-000000000001', '55555555-5555-4555-8555-000000000001',
            'DBT-CHECK-14', 100.00, 'Check 14');
    INSERT INTO app.legal_cases (client_id, debt_id, instrument_id, amount_claimed)
    VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-0000000000aa',
            '55555555-5555-4555-8555-000000000001', 100.00);
    RAISE EXCEPTION 'CHECK 14c FAILED: one note was used for two open requests';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- A request number only after submitting.
  BEGIN
    UPDATE app.legal_cases SET najiz_request_number = '401014800000001' WHERE id = v_case;
    RAISE EXCEPTION 'CHECK 14d FAILED: a request number was saved before submitting';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Status history: staff entries name the staff member, and the history cannot be changed.
  BEGIN
    INSERT INTO app.legal_case_events (client_id, legal_case_id, status, source)
    VALUES ('11111111-1111-4111-8111-111111111111', v_case, 'ready', 'staff');
    RAISE EXCEPTION 'CHECK 14e FAILED: a staff history entry without the staff member was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO app.legal_case_events (client_id, legal_case_id, status, source, recorded_by)
  VALUES ('11111111-1111-4111-8111-111111111111', v_case, 'ready', 'staff', '22222222-2222-4222-8222-000000000002');
  BEGIN
    UPDATE app.legal_case_events SET note = 'changed' WHERE legal_case_id = v_case;
    RAISE EXCEPTION 'CHECK 14f FAILED: status history was changed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- The other client cannot see this history.
  PERFORM set_config('app.client_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
  ASSERT (SELECT count(*) FROM app.legal_case_events) = 0,
    'CHECK 14g FAILED: another client can see the status history';
  PERFORM set_config('app.client_id', '11111111-1111-4111-8111-111111111111', true);

  RAISE NOTICE 'PASS 14: Najiz filing data follows its rules';
END $$;

ROLLBACK;
\echo 'All database checks passed.'
