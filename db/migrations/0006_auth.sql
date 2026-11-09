-- =====================================================================
-- 0006: login for client staff (step 4.2)
--
-- Email and password, sessions in a cookie, and "forgot password" by an
-- emailed link. Decided by Sal on 9 November 2026.
--
-- Passwords, sessions and reset links live in their own schema, `auth`.
-- The application roles get NO access to its tables. They can only call
-- the few functions below (SECURITY DEFINER, owned by the migration
-- owner), each doing one narrow thing. So a bug elsewhere in the API can
-- never read a password hash or another person's session.
--
-- Passwords are hashed in the API (scrypt) before they reach the
-- database, so a plain password never appears in a query or a log.
-- Tokens (session cookie, reset link) are random; only their SHA-256
-- digest is stored, so a copy of this table cannot be used to log in.
-- =====================================================================

-- The functions below see `public` (where citext's case-insensitive comparison lives).
-- Nobody but its owner may create objects there, so nothing can be slipped in ahead of them.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Login is by email, so an email must point to exactly one person.
CREATE UNIQUE INDEX users_email_one_person ON app.users (email);

CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;

CREATE TABLE auth.credentials (
  user_id             uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  password_hash       text NOT NULL,                -- scrypt$N$r$p$salt$hash, made by the API
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  failed_logins       int NOT NULL DEFAULT 0,
  locked_until        timestamptz
);

CREATE TABLE auth.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,              -- sha256 of the cookie value
  user_id       uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,               -- absolute end, however active
  ip            inet,
  user_agent    text
);
CREATE INDEX sessions_user ON auth.sessions (user_id);

CREATE TABLE auth.reset_links (
  token_hash  bytea PRIMARY KEY,                    -- sha256 of the token in the emailed link
  user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('reset', 'invite')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX reset_links_user ON auth.reset_links (user_id);

-- ---------------------------------------------------------------------
-- The functions the API may call. Each one is the only door to its job.
-- ---------------------------------------------------------------------

-- A user is allowed in when the user is active and the client is not suspended or closed.
CREATE FUNCTION auth.login_info(p_email citext)
RETURNS TABLE (user_id uuid, client_id uuid, password_hash text, locked_until timestamptz, can_log_in boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.client_id, c.password_hash, c.locked_until,
         u.is_active AND cl.status IN ('onboarding', 'active')
    FROM app.users u
    JOIN app.clients cl ON cl.id = u.client_id
    LEFT JOIN auth.credentials c ON c.user_id = u.id
   WHERE u.email = p_email
$$;

-- After a password check: reset the counter, or count the failure and lock for a while.
CREATE FUNCTION auth.record_login(p_user_id uuid, p_ok boolean, p_lock_after int, p_lock_minutes int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_client uuid; v_failed int;
BEGIN
  SELECT client_id INTO v_client FROM app.users WHERE id = p_user_id;
  IF p_ok THEN
    UPDATE auth.credentials SET failed_logins = 0, locked_until = NULL WHERE user_id = p_user_id;
    UPDATE app.users SET last_login_at = now() WHERE id = p_user_id;
  ELSE
    UPDATE auth.credentials
       SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= p_lock_after
                               THEN now() + make_interval(mins => p_lock_minutes) END
     WHERE user_id = p_user_id
    RETURNING failed_logins INTO v_failed;
    IF v_failed >= p_lock_after THEN
      INSERT INTO audit.activity_log (client_id, actor_type, actor_id, action, target_table, target_id, details)
      VALUES (v_client, 'user', p_user_id, 'auth.locked', 'app.users', p_user_id,
              jsonb_build_object('failed_logins', v_failed, 'minutes', p_lock_minutes));
    END IF;
  END IF;
END $$;

CREATE FUNCTION auth.create_session(p_user_id uuid, p_token_hash bytea, p_expires_at timestamptz, p_ip inet, p_user_agent text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  INSERT INTO auth.sessions (token_hash, user_id, expires_at, ip, user_agent)
  VALUES (p_token_hash, p_user_id, p_expires_at, p_ip, left(p_user_agent, 300));
  INSERT INTO audit.activity_log (client_id, actor_type, actor_id, action, target_table, target_id)
  SELECT client_id, 'user', id, 'auth.login', 'app.users', id FROM app.users WHERE id = p_user_id;
$$;

-- Who a session cookie belongs to. Ends sessions that expired, sat idle too long,
-- or belong to a user or client that may no longer log in.
CREATE FUNCTION auth.session_user(p_token_hash bytea, p_idle_minutes int)
RETURNS TABLE (user_id uuid, client_id uuid, full_name text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s auth.sessions;
BEGIN
  SELECT * INTO s FROM auth.sessions WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN RETURN; END IF;
  IF s.expires_at <= now() OR s.last_seen_at <= now() - make_interval(mins => p_idle_minutes) THEN
    DELETE FROM auth.sessions WHERE id = s.id;
    RETURN;
  END IF;
  RETURN QUERY
    SELECT u.id, u.client_id, u.full_name, u.role
      FROM app.users u JOIN app.clients cl ON cl.id = u.client_id
     WHERE u.id = s.user_id AND u.is_active AND cl.status IN ('onboarding', 'active');
  IF NOT FOUND THEN
    DELETE FROM auth.sessions WHERE id = s.id;
    RETURN;
  END IF;
  -- Note activity at most once a minute, to keep writes low.
  IF s.last_seen_at < now() - interval '1 minute' THEN
    UPDATE auth.sessions SET last_seen_at = now() WHERE id = s.id;
  END IF;
END $$;

CREATE FUNCTION auth.end_session(p_token_hash bytea)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  DELETE FROM auth.sessions WHERE token_hash = p_token_hash;
$$;

-- Make a reset (or invitation) link for an active user. Older unused links stop working.
-- Returns nothing for an unknown email; the API answers the same either way.
CREATE FUNCTION auth.create_reset_link(p_email citext, p_token_hash bytea, p_kind text, p_expires_at timestamptz)
RETURNS TABLE (user_id uuid, full_name text, company text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_user uuid; v_name text; v_company text;
BEGIN
  SELECT u.id, u.full_name, coalesce(cl.trade_name, cl.legal_name) INTO v_user, v_name, v_company
    FROM app.users u JOIN app.clients cl ON cl.id = u.client_id
   WHERE u.email = p_email AND u.is_active AND cl.status IN ('onboarding', 'active');
  IF v_user IS NULL THEN RETURN; END IF;
  UPDATE auth.reset_links SET used_at = now() WHERE reset_links.user_id = v_user AND used_at IS NULL;
  INSERT INTO auth.reset_links (token_hash, user_id, kind, expires_at) VALUES (p_token_hash, v_user, p_kind, p_expires_at);
  RETURN QUERY SELECT v_user, v_name, v_company;
END $$;

-- Is this link still good? (For the page that asks for the new password.)
CREATE FUNCTION auth.check_reset_link(p_token_hash bytea)
RETURNS TABLE (kind text, full_name text, email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT r.kind, u.full_name, u.email::text
    FROM auth.reset_links r JOIN app.users u ON u.id = r.user_id
   WHERE r.token_hash = p_token_hash AND r.used_at IS NULL AND r.expires_at > now() AND u.is_active
$$;

-- Use a link once: set the new password, end every session of that user.
CREATE FUNCTION auth.use_reset_link(p_token_hash bytea, p_password_hash text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r auth.reset_links; v_client uuid;
BEGIN
  SELECT * INTO r FROM auth.reset_links
   WHERE token_hash = p_token_hash AND used_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT client_id INTO v_client FROM app.users WHERE id = r.user_id AND is_active;
  IF v_client IS NULL THEN RETURN NULL; END IF;

  UPDATE auth.reset_links SET used_at = now() WHERE token_hash = p_token_hash;
  INSERT INTO auth.credentials (user_id, password_hash) VALUES (r.user_id, p_password_hash)
  ON CONFLICT (user_id) DO UPDATE
     SET password_hash = excluded.password_hash, password_changed_at = now(), failed_logins = 0, locked_until = NULL;
  DELETE FROM auth.sessions WHERE user_id = r.user_id;
  INSERT INTO audit.activity_log (client_id, actor_type, actor_id, action, target_table, target_id, details)
  VALUES (v_client, 'user', r.user_id, 'auth.password_set', 'app.users', r.user_id, jsonb_build_object('via', r.kind));
  RETURN r.user_id;
END $$;

-- Log someone out everywhere (for example when an admin deactivates them).
CREATE FUNCTION auth.end_user_sessions(p_user_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  DELETE FROM auth.sessions
   WHERE user_id = p_user_id
     -- Only for a user of the client acting now (the API is inside withTenant).
     AND EXISTS (SELECT 1 FROM app.users WHERE id = p_user_id AND client_id = app.current_client_id());
$$;

-- Only the API may call these; nobody may touch the tables directly.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO talos_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO talos_app;
