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
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; is_app: boolean }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            pg_has_role(current_user, 'talos_app', 'MEMBER') AS is_app
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || !role.is_app) {
    throw new Error(
      'The API database user must be a member of talos_app and must not be a superuser or bypass RLS. ' +
        'Use the talos_api role (see dev/roles.sql).',
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
