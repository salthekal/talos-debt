-- =====================================================================
-- Development login roles. DEVELOPMENT ONLY: fixed, public passwords.
-- In production, Karam creates these roles with strong secret passwords.
--
--   talos_api   the API server.  Member of talos_app, so RLS applies.
--   talos_jobs  the worker.      Member of talos_worker, bypasses RLS.
--
-- BYPASSRLS is a role attribute and is NOT inherited through membership,
-- so the worker login role must be given BYPASSRLS itself. Without it the
-- worker sees no rows at all and every incoming message looks unknown.
--
-- Roles belong to the whole PostgreSQL server, so this is safe to rerun.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talos_api') THEN
    CREATE ROLE talos_api LOGIN PASSWORD 'talos_api_dev' IN ROLE talos_app;
  ELSE
    ALTER ROLE talos_api LOGIN PASSWORD 'talos_api_dev';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talos_jobs') THEN
    CREATE ROLE talos_jobs LOGIN BYPASSRLS PASSWORD 'talos_jobs_dev' IN ROLE talos_worker;
  ELSE
    ALTER ROLE talos_jobs LOGIN BYPASSRLS PASSWORD 'talos_jobs_dev';
  END IF;
END $$;
