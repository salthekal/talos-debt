-- =====================================================================
-- 0002: track when each debtor phone last messaged us
--
-- WhatsApp allows free-form replies only within 24 hours of the
-- debtor's last message; outside that window the agent must use an
-- approved template. Storing the time on the phone row lets the agent
-- check the window without scanning the messages table.
--
-- Kept up to date automatically from inbound WhatsApp messages.
-- =====================================================================

ALTER TABLE app.debtor_phones
  ADD COLUMN last_inbound_at timestamptz;

-- Fill from existing inbound messages.
UPDATE app.debtor_phones p
   SET last_inbound_at = m.last_at
  FROM (SELECT phone_id, max(created_at) AS last_at
          FROM app.messages
         WHERE direction = 'inbound' AND channel = 'whatsapp' AND phone_id IS NOT NULL
         GROUP BY phone_id) m
 WHERE p.id = m.phone_id;

CREATE OR REPLACE FUNCTION app.touch_phone_last_inbound() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.channel = 'whatsapp' AND NEW.phone_id IS NOT NULL THEN
    UPDATE app.debtor_phones
       SET last_inbound_at = greatest(coalesce(last_inbound_at, NEW.created_at), NEW.created_at)
     WHERE client_id = NEW.client_id AND id = NEW.phone_id;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER messages_touch_phone_last_inbound
  AFTER INSERT ON app.messages
  FOR EACH ROW EXECUTE FUNCTION app.touch_phone_last_inbound();

-- True when a free-form WhatsApp reply is allowed for this phone.
CREATE OR REPLACE FUNCTION app.whatsapp_window_open(p_phone_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(last_inbound_at > now() - interval '24 hours', false)
    FROM app.debtor_phones WHERE id = p_phone_id
$$;
GRANT EXECUTE ON FUNCTION app.whatsapp_window_open(uuid) TO talos_app, talos_worker;
