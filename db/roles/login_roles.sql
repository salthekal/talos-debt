-- =====================================================================
-- Login roles for the API and the worker. Used for development AND
-- production, so the two are always set up the same way.
--
--   talos_api   the API server.  Member of talos_app: RLS applies.
--   talos_jobs  the worker.      Member of talos_worker: sees all clients
--                                through the worker_all policies (0003).
--
-- Neither role has any special attribute (no superuser, no BYPASSRLS,
-- no CREATEROLE or CREATEDB), so this works on managed databases where
-- the admin account is not a real superuser.
--
-- Passwords come from environment variables, never from this file:
--   TALOS_API_PASSWORD, TALOS_JOBS_PASSWORD
-- Each may be a plain password (development) or a SCRAM-SHA-256 verifier
-- (production, made by scripts/create-login-roles.sh), so the real
-- password never reaches the server or its logs.
--
-- Run after the migrations, as the admin account that ran them:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f db/roles/login_roles.sql
-- Safe to rerun: existing roles are updated (rerunning rotates passwords).
-- Needs psql 15 or newer (for \getenv).
-- =====================================================================

-- Short error messages only, so a failed statement never prints a password.
\set VERBOSITY terse
\set SHOW_CONTEXT never

\getenv api_password TALOS_API_PASSWORD
\getenv jobs_password TALOS_JOBS_PASSWORD
\if :{?api_password}
\else
  \set api_password ''
\endif
\if :{?jobs_password}
\else
  \set jobs_password ''
\endif

-- Hand the passwords to the DO block below through session settings.
-- No output, so the values are not echoed.
SELECT set_config('talos.api_password', :'api_password', false) IS NULL AS _ \gset
SELECT set_config('talos.jobs_password', :'jobs_password', false) IS NULL AS _ \gset

DO $$
DECLARE
  api_pw  text := current_setting('talos.api_password');
  jobs_pw text := current_setting('talos.jobs_password');
  r       record;
BEGIN
  IF api_pw = '' OR jobs_pw = '' THEN
    RAISE EXCEPTION 'TALOS_API_PASSWORD and TALOS_JOBS_PASSWORD must both be set';
  END IF;

  FOR r IN SELECT * FROM (VALUES ('talos_api', api_pw, 'talos_app', 'talos_worker', 20),
                                 ('talos_jobs', jobs_pw, 'talos_worker', 'talos_app', 10))
                    AS v(name, pw, member_of, never_in, conn_limit)
  LOOP
    -- New roles get no special attributes (the defaults). On a managed database
    -- the admin may not even restate NOSUPERUSER or NOBYPASSRLS, so existing
    -- roles only get their password and limits here; check_login_roles.sql
    -- then confirms the attributes are safe.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.name) THEN
      EXECUTE format('CREATE ROLE %I LOGIN INHERIT PASSWORD %L', r.name, r.pw);
    END IF;
    EXECUTE format('ALTER ROLE %I LOGIN CONNECTION LIMIT %s PASSWORD %L', r.name, r.conn_limit, r.pw);
    IF NOT pg_has_role(r.name, r.member_of, 'MEMBER') THEN
      EXECUTE format('GRANT %I TO %I', r.member_of, r.name);
    END IF;
    IF pg_has_role(r.name, r.never_in, 'MEMBER') THEN
      EXECUTE format('REVOKE %I FROM %I', r.never_in, r.name);
    END IF;
    -- A stuck query or an open transaction must not hold locks for long.
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L', r.name, '30s');
    EXECUTE format('ALTER ROLE %I SET idle_in_transaction_session_timeout = %L', r.name, '60s');
  END LOOP;

  -- Only the application roles may connect to this database.
  EXECUTE format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO talos_app, talos_worker', current_database());
END $$;

-- Forget the passwords for the rest of this session.
SELECT set_config('talos.api_password', '', false) IS NULL AS _ \gset
SELECT set_config('talos.jobs_password', '', false) IS NULL AS _ \gset
\unset api_password
\unset jobs_password
