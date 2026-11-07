import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { withTenant, type TenantContext } from './db.js';
import { isUuid } from './validation.js';

export type Role = 'owner' | 'admin' | 'staff' | 'viewer';

export interface AuthUser {
  clientId: string;
  userId: string;
  role: Role;
  fullName: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function tenantOf(user: AuthUser): TenantContext {
  return { clientId: user.clientId, userId: user.userId, actorType: 'user' };
}

/**
 * Development login: trusts the x-client-id and x-user-id headers, then checks
 * under RLS that the user really belongs to that client and is active.
 * Replaced by real login before any real data is used.
 */
export function devAuth(pool: pg.Pool) {
  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    const clientId = req.headers['x-client-id'];
    const userId = req.headers['x-user-id'];
    if (typeof clientId !== 'string' || typeof userId !== 'string' || !isUuid(clientId) || !isUuid(userId)) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid x-client-id / x-user-id' });
    }
    const user = await withTenant(pool, { clientId, userId, actorType: 'user' }, async (db) => {
      const { rows } = await db.query<{ role: Role; full_name: string }>(
        `SELECT role, full_name FROM app.users WHERE id = $1 AND is_active`,
        [userId],
      );
      return rows[0];
    });
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Unknown user for this client' });
    }
    req.user = { clientId, userId, role: user.role, fullName: user.full_name };
  };
}

/** Roles allowed to approve or reject payments and resolve disputes. */
export const REVIEWER_ROLES: readonly Role[] = ['owner', 'admin', 'staff'];

export function requireRole(allowed: readonly Role[]) {
  return async function check(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user || !allowed.includes(req.user.role)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Your role cannot do this' });
    }
  };
}
