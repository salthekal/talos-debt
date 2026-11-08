-- =====================================================================
-- Group roles, created BEFORE the migrations on a new database server.
--
--   talos_app     the API's group. RLS applies.
--   talos_worker  the worker's group. Sees all clients through the
--                 worker_all policies (migration 0003).
--
-- 0001 creates these only if they do not exist, and asks for BYPASSRLS
-- on talos_worker. Only a real superuser can grant BYPASSRLS, which
-- managed databases (Cloud SQL, RDS, Azure and similar) do not give, so
-- 0001 fails there. Creating the roles first, without BYPASSRLS, lets
-- 0001 skip that step. BYPASSRLS is not needed: it is not inherited by
-- login roles anyway, and 0003 gives the worker its access.
--
-- Roles belong to the whole server, so this is safe to rerun.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talos_app') THEN
    CREATE ROLE talos_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talos_worker') THEN
    CREATE ROLE talos_worker NOLOGIN;
  END IF;
  -- Older development servers created talos_worker with BYPASSRLS. Remove it
  -- so development matches production (only possible, and only needed, there).
  IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'talos_worker') THEN
    ALTER ROLE talos_worker NOBYPASSRLS;
  END IF;
END $$;
