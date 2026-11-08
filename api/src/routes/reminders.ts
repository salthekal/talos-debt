import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { REVIEWER_ROLES, requireRole, tenantOf } from '../auth.js';
import { withTenant } from '../db.js';
import { idParam, isUuid, parseOr400 } from '../validation.js';

const approveBody = z.union([
  z.object({ task_ids: z.array(z.string().refine(isUuid, 'must be a UUID')).min(1).max(500) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);
const cancelBody = z.object({ reason: z.string().trim().min(3).max(300) });
const waitingQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/**
 * The scheduler's work, as seen by client staff (Phase 2).
 *
 * When a client has auto_send off, reminders are planned but not sent until
 * a staff member approves them here. The scheduler still checks the stop
 * rules and working hours at the moment it sends, so approving never sends
 * to a debt that has since been paid, disputed or paused.
 */
export function reminderRoutes(app: FastifyInstance, pool: pg.Pool) {
  const guard = { preHandler: requireRole(REVIEWER_ROLES) };

  // Reminders due within the next day that wait for approval.
  app.get('/api/reminders/waiting', async (req, reply) => {
    const q = parseOr400(waitingQuery, req.query ?? {}, reply);
    if (!q) return;
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const rules = await db.query<{ auto_send: boolean }>(
        `SELECT coalesce(r.auto_send, false) AS auto_send
           FROM app.clients c LEFT JOIN app.follow_up_rules r ON r.client_id = c.id
          WHERE c.id = app.current_client_id()`,
      );
      const autoSend = rules.rows[0]?.auto_send ?? false;
      if (autoSend) return { auto_send: true, reminders: [] };
      const { rows } = await db.query(
        `SELECT t.id AS task_id, t.due_at, t.attempt_number, d.id AS debt_id, d.ref_code, d.amount_outstanding,
                d.status AS debt_status, dr.id AS debtor_id, dr.full_name, dr.preferred_language
           FROM app.follow_up_tasks t
           JOIN app.debts d ON d.id = t.debt_id
           JOIN app.debtors dr ON dr.id = d.debtor_id
          WHERE t.task_type = 'send_reminder' AND t.status = 'pending' AND t.approved_at IS NULL
            AND t.due_at <= now() + interval '1 day'
          ORDER BY t.due_at, d.ref_code
          LIMIT $1`,
        [q.limit],
      );
      return { auto_send: false, reminders: rows };
    });
  });

  // Approve some or all waiting reminders. They go out at their planned time, within working hours.
  app.post('/api/reminders/approve', guard, async (req, reply) => {
    const body = parseOr400(approveBody, req.body ?? {}, reply);
    if (!body) return;
    const user = req.user!;
    const ids = 'task_ids' in body ? body.task_ids : null;
    const approved = await withTenant(pool, tenantOf(user), async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `UPDATE app.follow_up_tasks
            SET approved_by = $1, approved_at = now()
          WHERE task_type = 'send_reminder' AND status = 'pending' AND approved_at IS NULL
            AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
            AND ($2::uuid[] IS NOT NULL OR due_at <= now() + interval '1 day')
          RETURNING id`,
        [user.userId, ids],
      );
      return rows.map((r) => r.id);
    });
    // Unknown ids (or another client's) are simply not approved: their existence is not revealed.
    return { approved: approved.length, task_ids: approved };
  });

  // The plan for one debt: what is due next and what happened before.
  app.get('/api/debts/:id/tasks', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const result = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const debt = await db.query(`SELECT 1 FROM app.debts WHERE id = $1`, [p.id]);
      if (!debt.rowCount) return undefined;
      const { rows } = await db.query(
        `SELECT id, task_type, attempt_number, due_at, status, skip_reason, last_error, tries,
                approved_by, approved_at, result_message_id, finished_at, created_at
           FROM app.follow_up_tasks WHERE debt_id = $1
          ORDER BY created_at DESC LIMIT 100`,
        [p.id],
      );
      return { tasks: rows };
    });
    if (!result) return reply.code(404).send({ error: 'not_found', message: 'Debt not found' });
    return result;
  });

  // Cancel a planned task (for example a reminder staff do not want sent). The planner
  // plans a new step for the debt later; to stop all reminders, pause the debt instead.
  app.post('/api/tasks/:id/cancel', guard, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(cancelBody, req.body ?? {}, reply);
    if (!body) return;
    const row = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `UPDATE app.follow_up_tasks
            SET status = 'cancelled', skip_reason = $2, finished_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING id, status`,
        [p.id, `cancelled_by_staff: ${body.reason}`.slice(0, 300)],
      );
      return rows[0];
    });
    if (!row) return reply.code(404).send({ error: 'not_found', message: 'No pending task with this id' });
    return row;
  });
}
