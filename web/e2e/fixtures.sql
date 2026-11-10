-- Extra fake data for the end-to-end run (web/e2e). Loaded after dev/seed.sql.
-- Notifications with details (migration 0007), so the screens show them in both languages.
BEGIN;
INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, created_at, data) VALUES
 ('11111111-1111-4111-8111-111111111111', 'payment_to_review', 'Rahim Uddin Demo sent a receipt', 'payments', NULL, now() - interval '7 hours',
  '{"event":"receipt","name":"Rahim Uddin Demo","ref":"DBT-2026-0003","amount":"1000.00","debtor_id":"33333333-3333-4333-8333-000000000003"}'),
 ('11111111-1111-4111-8111-111111111111', 'dispute', 'Ahmed Hassan Demo disputes the amount', 'disputes', NULL, now() - interval '20 hours',
  '{"event":"dispute","name":"Ahmed Hassan Demo","ref":"DBT-2026-0004","debtor_id":"33333333-3333-4333-8333-000000000004"}'),
 ('11111111-1111-4111-8111-111111111111', 'reply', 'Fahad Demo needs a reply', 'debts', NULL, now() - interval '26 hours',
  '{"event":"needs_reply","name":"Fahad Demo","ref":"DBT-2026-0002","debtor_id":"33333333-3333-4333-8333-000000000002"}'),
 ('11111111-1111-4111-8111-111111111111', 'system', 'Daily summary', NULL, NULL, now() - interval '30 hours',
  '{"event":"summary","day":"2026-11-08","summary":{"reminders_sent":4,"replies":2,"promises":1,"payments_to_review":1}}'),
 ('11111111-1111-4111-8111-111111111111', 'system', 'Reminder not sent', 'debts', NULL, now() - interval '3 days',
  '{"event":"not_sent","name":"Imran Khan Demo","ref":"DBT-2026-0001","debtor_id":"33333333-3333-4333-8333-000000000001"}');

-- A debt ready for legal, on its way to Najiz (Phase 5): every detail is there
-- except the company's commercial registration and the copy of the note, which the run uploads.
INSERT INTO app.debtors (id, client_id, ref_code, id_type, id_number, full_name, nationality, preferred_language,
                         first_name, father_name, family_name)
VALUES ('33333333-3333-4333-8333-000000000099', '11111111-1111-4111-8111-111111111111', 'D-000099', 'iqama', '2000000099',
        'Javed Iqbal Demo', 'PK', 'ur', 'Javed', 'Iqbal', 'Demo');
INSERT INTO app.debtor_phones (client_id, debtor_id, phone_e164, label, is_primary, has_whatsapp)
VALUES ('11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000099', '+966500000099', 'personal', true, true);
INSERT INTO app.instruments (id, client_id, debtor_id, type_code, reference_number, issue_date, face_amount, issue_country, issue_city, due_on_demand)
VALUES ('55555555-5555-4555-8555-000000000099', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000099',
        'nafith_promissory_note', 'NAFITH-DEMO-0099', '2025-12-01', 5000.00, 'SA', 'Jeddah', true);
INSERT INTO app.debts (id, client_id, debtor_id, instrument_id, ref_code, amount_original, amount_outstanding, reason,
                       reason_category, status, attempts_count, last_contact_at)
VALUES ('66666666-6666-4666-8666-000000000099', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-000000000099',
        '55555555-5555-4555-8555-000000000099', 'DBT-2026-0099', 5000.00, 4200.00, 'Motorcycle rent', 'vehicle_rent',
        'legal_ready', 5, now() - interval '4 days');
COMMIT;
