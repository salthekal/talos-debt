-- =====================================================================
-- Development seed data. FAKE DATA ONLY. Never load into production.
--
-- One fake client (a delivery company), two users, five debtors with
-- different situations, and Talos default WhatsApp templates.
-- Fixed UUIDs so the API, tests and demos can refer to them.
--
-- Run as the database owner after the migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f dev/seed.sql
-- =====================================================================

BEGIN;

-- The seed acts as the system, not a logged-in user.
SET LOCAL app.actor_type = 'system';

-- ---------------------------------------------------------------------
-- Sender number (Meta test number; ids are placeholders)
-- ---------------------------------------------------------------------
INSERT INTO app.sender_numbers (id, phone_number_id, waba_id, display_phone, display_name, is_shared)
VALUES ('00000000-0000-4000-8000-000000000001', 'TEST_PHONE_NUMBER_ID', 'TEST_WABA_ID',
        '+15550000000', 'Talos (test)', true);

-- ---------------------------------------------------------------------
-- Client
-- ---------------------------------------------------------------------
INSERT INTO app.clients (id, legal_name, trade_name, cr_number, sector, activity,
                         owner_name, owner_phone, owner_email, iban, bank_name, plan,
                         sender_number_id, authorization_signed_at, status)
VALUES ('11111111-1111-4111-8111-111111111111',
        'مؤسسة النخبة التجريبية للتوصيل', 'Al Nokhba Demo Delivery', '0000000001', 'logistics',
        'Last-mile delivery', 'Demo Owner', '+966500000100', 'owner@demo.example',
        'SA0000000000000000000000', 'Demo Bank', 'trial',
        '00000000-0000-4000-8000-000000000001', now(), 'active');

INSERT INTO app.users (id, client_id, full_name, email, phone, role) VALUES
 ('22222222-2222-4222-8222-000000000001', '11111111-1111-4111-8111-111111111111',
  'Demo Owner', 'owner@demo.example', '+966500000100', 'owner'),
 ('22222222-2222-4222-8222-000000000002', '11111111-1111-4111-8111-111111111111',
  'Demo Collections Staff', 'staff@demo.example', '+966500000101', 'staff');

-- Development password for both fake users: talos-dev-password
-- (a public, development-only value; real users set their own through an emailed link).
INSERT INTO auth.credentials (user_id, password_hash) VALUES
 ('22222222-2222-4222-8222-000000000001', 'scrypt$32768$8$1$q1mxvHhfWtEKnnnSE9poIQ==$bEJNVC56snxqb5qackDaZMJtT1B3l4ZFkDgKm1IQ0G8='),
 ('22222222-2222-4222-8222-000000000002', 'scrypt$32768$8$1$q1mxvHhfWtEKnnnSE9poIQ==$bEJNVC56snxqb5qackDaZMJtT1B3l4ZFkDgKm1IQ0G8=');

INSERT INTO app.follow_up_rules (client_id, interval_days, max_attempts, working_hours_start,
                                 working_hours_end, legal_after_attempts, languages, auto_send)
VALUES ('11111111-1111-4111-8111-111111111111', 2, 5, '09:00', '20:00', 5, '{ar,en,ur}', false);

-- ---------------------------------------------------------------------
-- Debtors (fake names, fake ID numbers, fake phones +9665000000xx)
-- ---------------------------------------------------------------------
INSERT INTO app.debtors (id, client_id, ref_code, id_type, id_number, full_name, full_name_ar,
                         nationality, preferred_language, employment_status) VALUES
 ('33333333-3333-4333-8333-000000000001', '11111111-1111-4111-8111-111111111111', 'D-000001',
  'iqama', '2000000001', 'Imran Khan Demo', 'عمران خان', 'PK', 'ur', 'left'),
 ('33333333-3333-4333-8333-000000000002', '11111111-1111-4111-8111-111111111111', 'D-000002',
  'national_id', '1000000002', 'Fahad Demo', 'فهد التجريبي', 'SA', 'ar', 'current'),
 ('33333333-3333-4333-8333-000000000003', '11111111-1111-4111-8111-111111111111', 'D-000003',
  'iqama', '2000000003', 'Rahim Uddin Demo', 'رحيم الدين', 'BD', 'en', 'left'),
 ('33333333-3333-4333-8333-000000000004', '11111111-1111-4111-8111-111111111111', 'D-000004',
  'iqama', '2000000004', 'Ahmed Hassan Demo', 'أحمد حسن', 'EG', 'ar', 'current'),
 ('33333333-3333-4333-8333-000000000005', '11111111-1111-4111-8111-111111111111', 'D-000005',
  'iqama', '2000000005', 'Suresh Kumar Demo', 'سوريش كومار', 'IN', 'en', 'left');

INSERT INTO app.debtor_phones (id, client_id, debtor_id, phone_e164, label, is_primary, has_whatsapp, status) VALUES
 ('44444444-4444-4444-8444-000000000001', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000001', '+966500000001', 'personal', true,  true, 'active'),
 ('44444444-4444-4444-8444-000000000002', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000001', '+966500000011', 'from platform', false, true, 'wrong_number'),
 ('44444444-4444-4444-8444-000000000003', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000002', '+966500000002', 'personal', true,  true, 'active'),
 ('44444444-4444-4444-8444-000000000004', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000003', '+966500000003', 'personal', true,  true, 'active'),
 ('44444444-4444-4444-8444-000000000005', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000004', '+966500000004', 'personal', true,  true, 'active'),
 ('44444444-4444-4444-8444-000000000006', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000005', '+966500000005', 'personal', true,  null, 'active');

-- ---------------------------------------------------------------------
-- Instruments
-- ---------------------------------------------------------------------
INSERT INTO app.instruments (id, client_id, debtor_id, type_code, reference_number, issue_date, face_amount) VALUES
 ('55555555-5555-4555-8555-000000000001', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000001',
  'nafith_promissory_note', 'NAFITH-DEMO-0001', '2025-03-01', 10000.00),
 ('55555555-5555-4555-8555-000000000002', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000003',
  'paper_promissory_note', 'PAPER-DEMO-0003', '2024-11-15', 8000.00),
 ('55555555-5555-4555-8555-000000000003', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000005',
  'cheque', 'CHQ-DEMO-0005', '2025-06-10', 2500.00);

-- ---------------------------------------------------------------------
-- Debts: one per situation the system must handle
--   D1 Imran   vehicle rent, Nafith note, several reminders, no reply   -> heading to legal
--   D2 Fahad   cash on delivery, no instrument, promised to pay
--   D3 Rahim   damages, paper note, debtor sent a receipt (pending approval)
--   D4 Ahmed   advance, no instrument, disputes the amount
--   D5 Suresh  vehicle rent, cheque, partly paid (approved payment)
-- ---------------------------------------------------------------------
INSERT INTO app.debts (id, client_id, debtor_id, instrument_id, ref_code, amount_original, amount_outstanding,
                       reason, reason_category, issue_date, due_date, status, attempts_count, last_contact_at) VALUES
 ('66666666-6666-4666-8666-000000000001', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000001',
  '55555555-5555-4555-8555-000000000001', 'DBT-2026-0001', 3450.00, 3450.00,
  'Unpaid motorcycle rent for August and September 2026', 'vehicle_rent', '2026-08-01', '2026-09-30',
  'in_follow_up', 4, now() - interval '2 days'),
 ('66666666-6666-4666-8666-000000000002', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000002',
  null, 'DBT-2026-0002', 1280.50, 1280.50,
  'Cash collected from customers on 12 October 2026 and not handed over', 'cash_on_delivery', '2026-10-12', '2026-10-19',
  'promised', 2, now() - interval '1 day'),
 ('66666666-6666-4666-8666-000000000003', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000003',
  '55555555-5555-4555-8555-000000000002', 'DBT-2026-0003', 2100.00, 2100.00,
  'Repair cost for damaged delivery motorcycle', 'damages', '2026-07-20', '2026-08-20',
  'in_follow_up', 3, now() - interval '3 days'),
 ('66666666-6666-4666-8666-000000000004', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000004',
  null, 'DBT-2026-0004', 1500.00, 1500.00,
  'Salary advance paid on 1 September 2026', 'advance', '2026-09-01', '2026-10-01',
  'in_follow_up', 1, now() - interval '4 days'),
 ('66666666-6666-4666-8666-000000000005', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000005',
  '55555555-5555-4555-8555-000000000003', 'DBT-2026-0005', 2500.00, 2500.00,
  'Unpaid car rent for June 2026', 'vehicle_rent', '2026-06-01', '2026-06-30',
  'in_follow_up', 2, now() - interval '5 days');

-- ---------------------------------------------------------------------
-- Talos default WhatsApp templates (client_id null = shared by all clients)
-- ---------------------------------------------------------------------
INSERT INTO app.message_templates (id, client_id, purpose, language, meta_template_name, body, variables, approval_status) VALUES
 ('77777777-7777-4777-8777-000000000001', null, 'first_reminder', 'ar', 'debt_first_reminder',
  'مرحباً {{1}}، نود تذكيركم بوجود مبلغ مستحق لصالح {{2}} بقيمة {{3}} ريال (المرجع {{4}}). للاستفسار أو السداد يرجى الرد على هذه الرسالة.',
  '{debtor_name,client_name,amount,debt_ref}', 'draft'),
 ('77777777-7777-4777-8777-000000000002', null, 'first_reminder', 'en', 'debt_first_reminder',
  'Hello {{1}}, this is a reminder that an amount of SAR {{3}} is due to {{2}} (reference {{4}}). Please reply to this message with any questions or to arrange payment.',
  '{debtor_name,client_name,amount,debt_ref}', 'draft'),
 ('77777777-7777-4777-8777-000000000003', null, 'follow_up', 'ar', 'debt_follow_up',
  'مرحباً {{1}}، لم نستلم بعد سداد المبلغ المستحق لصالح {{2}} بقيمة {{3}} ريال (المرجع {{4}}). يرجى السداد أو التواصل معنا بالرد على هذه الرسالة.',
  '{debtor_name,client_name,amount,debt_ref}', 'draft'),
 ('77777777-7777-4777-8777-000000000004', null, 'follow_up', 'en', 'debt_follow_up',
  'Hello {{1}}, we have not yet received payment of SAR {{3}} due to {{2}} (reference {{4}}). Please pay or reply to this message to contact us.',
  '{debtor_name,client_name,amount,debt_ref}', 'draft'),
 ('77777777-7777-4777-8777-000000000005', null, 'payment_received', 'ar', 'debt_payment_received',
  'شكراً {{1}}، تم استلام دفعة بقيمة {{2}} ريال للمرجع {{3}}. المبلغ المتبقي {{4}} ريال.',
  '{debtor_name,amount_paid,debt_ref,amount_outstanding}', 'draft'),
 ('77777777-7777-4777-8777-000000000006', null, 'payment_received', 'en', 'debt_payment_received',
  'Thank you {{1}}, we received a payment of SAR {{2}} for reference {{3}}. The remaining amount is SAR {{4}}.',
  '{debtor_name,amount_paid,debt_ref,amount_outstanding}', 'draft');

-- ---------------------------------------------------------------------
-- Message history
-- ---------------------------------------------------------------------
INSERT INTO app.messages (id, client_id, debtor_id, debt_id, phone_id, sender_number_id, channel, direction,
                          template_id, body, ai_generated, status, provider_message_id, sent_at, created_at) VALUES
 -- D1: reminders, no reply
 ('88888888-8888-4888-8888-000000000001', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000001',
  '66666666-6666-4666-8666-000000000001', '44444444-4444-4444-8444-000000000001', '00000000-0000-4000-8000-000000000001',
  'whatsapp', 'outbound', '77777777-7777-4777-8777-000000000002',
  'Hello Imran Khan Demo, this is a reminder that an amount of SAR 3450.00 is due to Al Nokhba Demo Delivery (reference DBT-2026-0001).',
  false, 'read', 'wamid.DEMO0001', now() - interval '8 days', now() - interval '8 days'),
 ('88888888-8888-4888-8888-000000000002', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000001',
  '66666666-6666-4666-8666-000000000001', '44444444-4444-4444-8444-000000000001', '00000000-0000-4000-8000-000000000001',
  'whatsapp', 'outbound', '77777777-7777-4777-8777-000000000004',
  'Hello Imran Khan Demo, we have not yet received payment of SAR 3450.00 (reference DBT-2026-0001).',
  false, 'delivered', 'wamid.DEMO0002', now() - interval '2 days', now() - interval '2 days'),
 -- D2: debtor promised to pay
 ('88888888-8888-4888-8888-000000000003', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000002',
  '66666666-6666-4666-8666-000000000002', '44444444-4444-4444-8444-000000000003', '00000000-0000-4000-8000-000000000001',
  'whatsapp', 'inbound', null, 'السلام عليكم، بسدد المبلغ يوم الخميس إن شاء الله',
  false, 'received', 'wamid.DEMO0003', null, now() - interval '1 day'),
 -- D3: debtor sent a receipt image
 ('88888888-8888-4888-8888-000000000004', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000003',
  '66666666-6666-4666-8666-000000000003', '44444444-4444-4444-8444-000000000004', '00000000-0000-4000-8000-000000000001',
  'whatsapp', 'inbound', null, 'I transferred 1000 today, receipt attached',
  false, 'received', 'wamid.DEMO0004', null, now() - interval '6 hours'),
 -- D4: debtor disputes
 ('88888888-8888-4888-8888-000000000005', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000004',
  '66666666-6666-4666-8666-000000000004', '44444444-4444-4444-8444-000000000005', '00000000-0000-4000-8000-000000000001',
  'whatsapp', 'inbound', null, 'المبلغ غلط، أنا أخذت سلفة 1000 بس مو 1500',
  false, 'received', 'wamid.DEMO0005', null, now() - interval '3 hours');

UPDATE app.debts SET last_reply_at = now() - interval '1 day'  WHERE id = '66666666-6666-4666-8666-000000000002';
UPDATE app.debts SET last_reply_at = now() - interval '6 hours' WHERE id = '66666666-6666-4666-8666-000000000003';
UPDATE app.debts SET last_reply_at = now() - interval '3 hours' WHERE id = '66666666-6666-4666-8666-000000000004';

-- D2 promise
INSERT INTO app.promises (client_id, debt_id, promised_amount, promised_date, source_message_id)
VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000002', null,
        current_date + 2, '88888888-8888-4888-8888-000000000003');

-- D3 receipt document and pending payment (waits for client approval)
INSERT INTO app.documents (id, client_id, debtor_id, debt_id, doc_type, file_name, storage_key, mime_type, size_bytes, sha256, source)
VALUES ('99999999-9999-4999-8999-000000000001', '11111111-1111-4111-8111-111111111111',
        '33333333-3333-4333-8333-000000000003', '66666666-6666-4666-8666-000000000003',
        'payment_proof', 'receipt-demo.jpg', 'dev/demo/receipt-demo.jpg', 'image/jpeg', 102400,
        encode(digest('demo receipt', 'sha256'), 'hex'), 'whatsapp_inbound');
UPDATE app.messages SET media_document_id = '99999999-9999-4999-8999-000000000001'
 WHERE id = '88888888-8888-4888-8888-000000000004';
INSERT INTO app.payments (client_id, debt_id, amount, method, paid_at, proof_document_id, source_message_id,
                          extracted_details, ai_match_confidence, status)
VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000003', 1000.00, 'bank_transfer',
        now() - interval '7 hours', '99999999-9999-4999-8999-000000000001', '88888888-8888-4888-8888-000000000004',
        '{"bank": "Demo Bank", "amount": 1000.00, "reference": "TRX-DEMO-1"}', 0.92, 'pending_approval');

-- D4 dispute (the trigger marks the debt disputed and cancels its reminders)
INSERT INTO app.disputes (client_id, debt_id, raised_message_id, reason)
VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000004',
        '88888888-8888-4888-8888-000000000005', 'Debtor says the advance was SAR 1000, not SAR 1500');

-- D5 approved partial payment (the trigger reduces the balance to 1000.00)
INSERT INTO app.payments (client_id, debt_id, amount, method, paid_at, status, reviewed_by, reviewed_at)
VALUES ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000005', 1500.00, 'bank_transfer',
        now() - interval '10 days', 'approved', '22222222-2222-4222-8222-000000000002', now() - interval '9 days');

-- Pending reminders for the scheduler to pick up later
INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, attempt_number, due_at) VALUES
 ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000001', 'send_reminder', 5, now() + interval '1 day'),
 ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000003', 'send_reminder', 4, now() + interval '1 day'),
 ('11111111-1111-4111-8111-111111111111', '66666666-6666-4666-8666-000000000005', 'send_reminder', 3, now() + interval '1 day');

COMMIT;
