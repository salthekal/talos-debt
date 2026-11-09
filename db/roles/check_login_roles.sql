-- =====================================================================
-- Checks that the login roles are set up safely. Run after
-- login_roles.sql, in development (scripts/db-reset.sh) and in
-- production (scripts/create-login-roles.sh). Read only.
-- Any failure stops the run with an error naming the check.
-- =====================================================================

\set QUIET on
DO $$
DECLARE missing text;
BEGIN
  -- 1. Both roles exist, can log in, and have no special attributes.
  ASSERT (SELECT count(*) FROM pg_roles
           WHERE rolname IN ('talos_api', 'talos_jobs') AND rolcanlogin
             AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole
             AND NOT rolcreatedb AND NOT rolreplication) = 2,
    'ROLE CHECK 1 FAILED: talos_api and talos_jobs must log in with no superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION';

  -- 1b. The group roles have no special attributes either.
  ASSERT (SELECT count(*) FROM pg_roles
           WHERE rolname IN ('talos_app', 'talos_worker') AND NOT rolsuper AND NOT rolbypassrls) = 2,
    'ROLE CHECK 1b FAILED: talos_app and talos_worker must exist with no superuser or BYPASSRLS';

  -- 2. Each role is in exactly the right group.
  ASSERT pg_has_role('talos_api', 'talos_app', 'MEMBER') AND NOT pg_has_role('talos_api', 'talos_worker', 'MEMBER'),
    'ROLE CHECK 2a FAILED: talos_api must be in talos_app and not in talos_worker';
  ASSERT pg_has_role('talos_jobs', 'talos_worker', 'MEMBER') AND NOT pg_has_role('talos_jobs', 'talos_app', 'MEMBER'),
    'ROLE CHECK 2b FAILED: talos_jobs must be in talos_worker and not in talos_app';

  -- 3. Neither role owns any table, view or function (owners skip RLS).
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('app', 'ai', 'audit') AND pg_get_userbyid(c.relowner) IN ('talos_api', 'talos_jobs')
    UNION ALL
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname IN ('app', 'ai', 'audit') AND pg_get_userbyid(p.proowner) IN ('talos_api', 'talos_jobs')),
    'ROLE CHECK 3 FAILED: talos_api or talos_jobs owns database objects';

  -- 4. Every table with Row Level Security lets the worker through (0003).
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'r' AND c.relrowsecurity AND n.nspname IN ('app', 'ai', 'audit')
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname = n.nspname AND p.tablename = c.relname
                        AND p.policyname = 'worker_all' AND 'talos_worker' = ANY (p.roles));
  ASSERT missing IS NULL, format('ROLE CHECK 4 FAILED: no worker_all policy on %s', missing);

  -- 5. The API never matches a worker policy (it must stay limited to one client).
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname IN ('app', 'ai', 'audit')
                        AND ('talos_app' = ANY (roles) OR 'talos_api' = ANY (roles))),
    'ROLE CHECK 5 FAILED: a policy is granted to talos_app or talos_api directly';

  -- 6. The audit log can never be changed by either role.
  ASSERT NOT has_table_privilege('talos_api', 'audit.activity_log', 'UPDATE, DELETE, TRUNCATE')
     AND NOT has_table_privilege('talos_jobs', 'audit.activity_log', 'UPDATE, DELETE, TRUNCATE'),
    'ROLE CHECK 6 FAILED: an application role can change or delete the audit log';

  -- 7. Passwords, sessions and reset links (0006) are reachable only through the auth functions.
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'auth' AND c.relkind = 'r'
       AND (has_table_privilege('talos_api', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
            OR has_table_privilege('talos_jobs', c.oid, 'SELECT, INSERT, UPDATE, DELETE'))),
    'ROLE CHECK 7 FAILED: an application role can read or change the auth tables directly';
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND has_function_privilege('talos_jobs', p.oid, 'EXECUTE')),
    'ROLE CHECK 7b FAILED: the worker can call the auth functions';

  RAISE NOTICE 'PASS: login roles are set up safely';
END $$;
