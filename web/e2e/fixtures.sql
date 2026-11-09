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
COMMIT;
