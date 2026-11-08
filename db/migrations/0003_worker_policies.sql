-- =====================================================================
-- 0003: let the worker see all clients through policies, not BYPASSRLS
--
-- The worker (scheduler and WhatsApp webhook) must see every client's
-- rows. 0001 gave the talos_worker group role BYPASSRLS, but PostgreSQL
-- does not pass BYPASSRLS down to login roles that are members of it,
-- and managed databases (Cloud SQL, RDS, Azure and similar) usually do
-- not let the admin account grant BYPASSRLS at all.
--
-- Policies DO apply through membership, so this adds one policy per
-- protected table that lets members of talos_worker read and write every
-- row. talos_app members are unaffected: they still only match the
-- tenant_isolation policies. Table privileges still decide what the
-- worker can do (for example, no UPDATE or DELETE on audit.activity_log).
--
-- Any new table that turns on Row Level Security must also get a
-- worker_all policy. dev/checks.sql fails if one is missing.
-- =====================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND c.relrowsecurity AND n.nspname IN ('app', 'ai', 'audit')
       AND NOT EXISTS (SELECT 1 FROM pg_policies p
                        WHERE p.schemaname = n.nspname AND p.tablename = c.relname AND p.policyname = 'worker_all')
  LOOP
    EXECUTE format('CREATE POLICY worker_all ON %I.%I TO talos_worker USING (true) WITH CHECK (true)',
                   r.schema_name, r.table_name);
  END LOOP;
END $$;
