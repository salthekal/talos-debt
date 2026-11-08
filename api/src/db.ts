import pg from 'pg';

export type ActorType = 'user' | 'system' | 'ai';

/** Who a database transaction acts for. Sets the values RLS and the audit log read. */
export interface TenantContext {
  clientId: string;
  userId?: string;
  actorType: ActorType;
}

export type Db = pg.PoolClient;

export function createPool(connectionString: string): pg.Pool {
  // numeric (money) stays a string, so amounts are never rounded through floats.
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Refuse to run the API with a role that would skip Row Level Security.
 * The API must connect as a member of talos_app, never as a superuser,
 * the table owner, or talos_worker.
 */
export async function assertRlsEnforced(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; is_app: boolean; is_worker: boolean }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            pg_has_role(current_user, 'talos_app', 'MEMBER') AS is_app,
            pg_has_role(current_user, 'talos_worker', 'MEMBER') AS is_worker
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = rows[0];
  // A member of talos_worker matches the worker_all policies and would see every client.
  if (!role || role.rolsuper || role.rolbypassrls || !role.is_app || role.is_worker) {
    throw new Error(
      'The API database user must be a member of talos_app, not of talos_worker, and must not be a superuser or bypass RLS. ' +
        'Use the talos_api role (see db/roles/login_roles.sql).',
    );
  }
}

/**
 * Run fn inside one transaction acting for a single client.
 * Every API query goes through here, so RLS always has a client to filter by.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      `SELECT set_config('app.client_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.actor_type', $3, true)`,
      [ctx.clientId, ctx.userId ?? '', ctx.actorType],
    );
    const result = await fn(db);
    await db.query('COMMIT');
    return result;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
}

/**
 * The worker connection must be a member of talos_worker (it stores raw webhooks),
 * not a superuser, and the worker_all policies (migration 0003) must be in place.
 * Without them the worker silently sees no rows and every message looks unknown.
 */
export async function assertWorkerRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ member: boolean; plain: boolean; policies: boolean }>(
    `SELECT pg_has_role(current_user, 'talos_worker', 'MEMBER') AS member,
            NOT r.rolsuper AS plain,
            EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'app' AND tablename = 'debtor_phones' AND policyname = 'worker_all') AS policies
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = rows[0];
  if (!role?.member || !role.plain) {
    throw new Error(
      'WORKER_DATABASE_URL must use a member of talos_worker that is not a superuser. ' +
        'Use talos_jobs (see db/roles/login_roles.sql).',
    );
  }
  if (!role.policies) {
    throw new Error('The worker policies are missing: run migration 0003_worker_policies.sql.');
  }
}
