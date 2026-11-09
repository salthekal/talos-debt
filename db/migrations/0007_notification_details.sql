-- =====================================================================
-- 0007: notification details, so the dashboard can show each
-- notification in the reader's language (Arabic or English).
--
-- `title` stays as the English text (emails, logs, older rows).
-- `data` holds the facts the text is built from, for example
-- {"name": "Rahim Uddin", "ref": "DBT-2026-0003", "amount": "1000.00"}.
-- Amounts are stored as text, like everywhere else.
-- =====================================================================

ALTER TABLE app.notifications ADD COLUMN data jsonb;

-- 'import_done' already exists; the list of kinds is unchanged.
