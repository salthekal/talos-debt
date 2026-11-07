import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { REVIEWER_ROLES, requireRole, tenantOf } from '../auth.js';
import { withTenant } from '../db.js';
import { idParam, parseOr400 } from '../validation.js';

const rejectBody = z.object({ reason: z.string().trim().min(3).max(500) });

/**
 * Payment review. Only approved payments reduce a debt's balance; the database
 * trigger recalculates the balance, marks the debt paid at zero, and cancels
 * pending reminders. The API only records the decision and who made it.
 */
export function paymentRoutes(app: FastifyInstance, pool: pg.Pool) {
  const guard = { preHandler: requireRole(REVIEWER_ROLES) };

  app.post('/api/payments/:id/approve', guard, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const user = req.user!;
    const result = await withTenant(pool, tenantOf(user), async (db) => {
      const updated = await db.query<{ debt_id: string }>(
        `UPDATE app.payments
            SET status = 'approved', reviewed_by = $2, reviewed_at = now()
          WHERE id = $1 AND status = 'pending_approval'
          RETURNING debt_id`,
        [p.id, user.userId],
      );
      const row = updated.rows[0];
      if (!row) return undefined;
      const debt = await db.query(
        `SELECT id, ref_code, amount_original, amount_outstanding, status FROM app.debts WHERE id = $1`,
        [row.debt_id],
      );
      return { paymentId: p.id, status: 'approved', debt: debt.rows[0] };
    });
    if (!result) {
      return reply.code(404).send({ error: 'not_found', message: 'No pending payment with this id' });
    }
    return result;
  });

  app.post('/api/payments/:id/reject', guard, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(rejectBody, req.body ?? {}, reply);
    if (!body) return;
    const user = req.user!;
    const result = await withTenant(pool, tenantOf(user), async (db) => {
      const updated = await db.query(
        `UPDATE app.payments
            SET status = 'rejected', rejection_reason = $3, reviewed_by = $2, reviewed_at = now()
          WHERE id = $1 AND status = 'pending_approval'
          RETURNING id`,
        [p.id, user.userId, body.reason],
      );
      return updated.rows[0];
    });
    if (!result) {
      return reply.code(404).send({ error: 'not_found', message: 'No pending payment with this id' });
    }
    return { paymentId: p.id, status: 'rejected' };
  });
}
