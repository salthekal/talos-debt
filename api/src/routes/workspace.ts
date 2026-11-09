import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { EDITOR_ROLES, REVIEWER_ROLES, requireRole, tenantOf, type Role } from '../auth.js';
import { withTenant, type Db } from '../db.js';
import { sendLink, type LoginDeps } from '../login/routes.js';
import { idParam, isUuid, parseOr400 } from '../validation.js';

/**
 * What the dashboard needs beyond the Phase 1 to 3 routes (Phase 4):
 * overview numbers, notifications, settings (follow-up rules, users),
 * deciding disputes, pausing and resuming, and recording a payment by hand.
 */

const ADMINS: readonly Role[] = ['owner', 'admin'];
const amount = z.string().trim().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Write the amount like 1500 or 1500.50');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const rulesBody = z
  .object({
    interval_days: z.number().int().min(1).max(30),
    max_attempts: z.number().int().min(1).max(50),
    legal_after_attempts: z.number().int().min(1).max(50),
    promise_grace_days: z.number().int().min(0).max(30),
    working_hours_start: time,
    working_hours_end: time,
    working_days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    auto_send: z.boolean(),
  })
  .partial()
  .strict();

const userBody = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['owner', 'admin', 'staff', 'viewer']),
});
const userPatch = z.object({ role: z.enum(['owner', 'admin', 'staff', 'viewer']), is_active: z.boolean() }).partial().strict();

const resolveBody = z.discriminatedUnion('outcome', [
  // The amount is right: follow-up starts again.
  z.object({ outcome: z.literal('amount_correct'), note: z.string().trim().min(3).max(1000) }),
  // The debtor is right: correct the total owed, close the debt, or pause it to fix later.
  z.object({ outcome: z.literal('debtor_right'), note: z.string().trim().min(3).max(1000), action: z.enum(['correct_amount', 'close', 'pause']), corrected_amount: amount.optional() }),
]);

const pauseBody = z.object({ until: z.string().date().optional(), reason: z.string().trim().min(3).max(500) });
const paymentBody = z.object({
  amount,
  method: z.enum(['bank_transfer', 'cash', 'salary_deduction', 'other']),
  paid_at: z.string().date(),
  note: z.string().trim().max(500).optional(),
});
const notesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), unread: z.enum(['true', 'false']).optional() });
const readBody = z.union([z.object({ ids: z.array(z.string().refine(isUuid)).min(1).max(200) }).strict(), z.object({ all: z.literal(true) }).strict()]);

/** Debts that are still being followed up move back to the right status after a pause or a dispute. */
const RESUME_STATUS = `CASE WHEN amount_outstanding = 0 THEN 'paid'
                            WHEN amount_outstanding < amount_original THEN 'partly_paid'
                            WHEN attempts_count > 0 THEN 'in_follow_up'
                            ELSE 'open' END`;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function workspaceRoutes(app: FastifyInstance, deps: { pool: pg.Pool; login: LoginDeps }) {
  const { pool } = deps;
  const run = async <T>(reply: import('fastify').FastifyReply, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  };

  // ---------------------------------------------------------------- overview

  app.get('/api/dashboard/summary', async (req) =>
    withTenant(pool, tenantOf(req.user!), async (db) => {
      const stages = await db.query<{ reminders_sent: number; promises_open: number; legal: number }>(
        `SELECT coalesce(sum(attempts_count), 0)::int AS reminders_sent,
                (SELECT count(*) FROM app.promises WHERE status = 'pending')::int AS promises_open,
                count(*) FILTER (WHERE status IN ('legal_ready', 'in_legal'))::int AS legal
           FROM app.debts`,
      );
      const byStatus = await db.query<{ status: string; count: number; outstanding: string }>(
        `SELECT status, count(*)::int AS count, sum(amount_outstanding)::numeric(14,2)::text AS outstanding
           FROM app.debts GROUP BY status`,
      );
      return { ...stages.rows[0], statuses: Object.fromEntries(byStatus.rows.map((r) => [r.status, { count: r.count, outstanding: r.outstanding }])) };
    }),
  );

  // ----------------------------------------------------------- notifications

  app.get('/api/notifications', async (req, reply) => {
    const q = parseOr400(notesQuery, req.query ?? {}, reply);
    if (!q) return;
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `SELECT n.id, n.kind, n.title, n.target_table, n.target_id, n.read_at, n.created_at,
                -- Details for older rows that have none: the debt's reference and debtor.
                coalesce(n.data, CASE WHEN d.id IS NOT NULL THEN jsonb_build_object('ref', d.ref_code, 'name', dr.full_name) END) AS data
           FROM app.notifications n
           LEFT JOIN app.debts d ON n.target_table = 'app.debts' AND d.id = n.target_id
           LEFT JOIN app.debtors dr ON dr.id = d.debtor_id
          WHERE (n.user_id IS NULL OR n.user_id = $1) AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
          ORDER BY n.created_at DESC LIMIT $3`,
        [req.user!.userId, q.unread === 'true', q.limit],
      );
      const unread = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.notifications WHERE read_at IS NULL AND (user_id IS NULL OR user_id = $1)`,
        [req.user!.userId],
      );
      return { unread: unread.rows[0]!.n, items: rows };
    });
  });

  app.post('/api/notifications/read', async (req, reply) => {
    const body = parseOr400(readBody, req.body ?? {}, reply);
    if (!body) return;
    const ids = 'ids' in body ? body.ids : null;
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rowCount } = await db.query(
        `UPDATE app.notifications SET read_at = now()
          WHERE read_at IS NULL AND (user_id IS NULL OR user_id = $1) AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`,
        [req.user!.userId, ids],
      );
      return { read: rowCount ?? 0 };
    });
  });

  // ---------------------------------------------------------- follow-up rules

  const loadRules = (db: Db) =>
    db.query(
      `SELECT coalesce(r.interval_days, 2) AS interval_days, coalesce(r.max_attempts, 5) AS max_attempts,
              coalesce(r.legal_after_attempts, 5) AS legal_after_attempts, coalesce(r.promise_grace_days, 1) AS promise_grace_days,
              to_char(coalesce(r.working_hours_start, '09:00'), 'HH24:MI') AS working_hours_start,
              to_char(coalesce(r.working_hours_end, '20:00'), 'HH24:MI') AS working_hours_end,
              coalesce(r.working_days, '{0,1,2,3,4}') AS working_days, coalesce(r.auto_send, false) AS auto_send,
              c.timezone
         FROM app.clients c LEFT JOIN app.follow_up_rules r ON r.client_id = c.id
        WHERE c.id = app.current_client_id()`,
    );

  app.get('/api/settings/rules', async (req) =>
    withTenant(pool, tenantOf(req.user!), async (db) => (await loadRules(db)).rows[0]),
  );

  app.patch('/api/settings/rules', { preHandler: requireRole(ADMINS) }, async (req, reply) => {
    const body = parseOr400(rulesBody, req.body ?? {}, reply);
    if (!body) return;
    return run(reply, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const current = (await loadRules(db)).rows[0];
        const next = { ...current, ...body };
        if (next.working_hours_end <= next.working_hours_start) {
          throw new HttpError(400, 'invalid', 'Working hours must end after they start');
        }
        await db.query(
          `INSERT INTO app.follow_up_rules (client_id, interval_days, max_attempts, legal_after_attempts, promise_grace_days,
                                            working_hours_start, working_hours_end, working_days, auto_send)
           VALUES (app.current_client_id(), $1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (client_id) DO UPDATE SET
             interval_days = excluded.interval_days, max_attempts = excluded.max_attempts,
             legal_after_attempts = excluded.legal_after_attempts, promise_grace_days = excluded.promise_grace_days,
             working_hours_start = excluded.working_hours_start, working_hours_end = excluded.working_hours_end,
             working_days = excluded.working_days, auto_send = excluded.auto_send`,
          [next.interval_days, next.max_attempts, next.legal_after_attempts, next.promise_grace_days,
           next.working_hours_start, next.working_hours_end, [...new Set(next.working_days as number[])].sort(), next.auto_send],
        );
        return (await loadRules(db)).rows[0];
      }),
    );
  });

  app.get('/api/templates', async (req) =>
    withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `SELECT id, purpose, language, meta_template_name, approval_status, body, client_id IS NULL AS shared
           FROM app.message_templates ORDER BY purpose, language`,
      );
      return { items: rows };
    }),
  );

  // -------------------------------------------------------------------- users

  app.get('/api/users', async (req) =>
    withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `SELECT id, full_name, email, role, is_active, last_login_at, created_at FROM app.users ORDER BY is_active DESC, full_name`,
      );
      return { items: rows };
    }),
  );

  // Add a user and email them a link to choose their password.
  app.post('/api/users', { preHandler: requireRole(ADMINS) }, async (req, reply) => {
    const body = parseOr400(userBody, req.body ?? {}, reply);
    if (!body) return;
    if (body.role === 'owner' && req.user!.role !== 'owner') {
      return reply.code(403).send({ error: 'forbidden', message: 'Only an owner can add another owner' });
    }
    const created = await run(reply, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        try {
          const { rows } = await db.query(
            `INSERT INTO app.users (client_id, full_name, email, role) VALUES (app.current_client_id(), $1, $2, $3)
             RETURNING id, full_name, email, role, is_active, last_login_at, created_at`,
            [body.full_name, body.email, body.role],
          );
          return rows[0];
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'email_taken', 'This email already has an account');
          throw err;
        }
      }),
    );
    if (!created || reply.sent) return created;
    await sendLink(deps.login, body.email, 'invite');
    return reply.code(201).send(created);
  });

  app.post('/api/users/:id/invite', { preHandler: requireRole(ADMINS) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const user = await withTenant(pool, tenantOf(req.user!), async (db) =>
      (await db.query<{ email: string }>(`SELECT email FROM app.users WHERE id = $1 AND is_active`, [p.id])).rows[0],
    );
    if (!user) return reply.code(404).send({ error: 'not_found', message: 'User not found' });
    await sendLink(deps.login, user.email, 'invite');
    return { sent: true };
  });

  app.patch('/api/users/:id', { preHandler: requireRole(ADMINS) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(userPatch, req.body ?? {}, reply);
    if (!body) return;
    const me = req.user!;
    if (p.id === me.userId) return reply.code(400).send({ error: 'own_account', message: 'You cannot change your own role or access' });
    return run(reply, () =>
      withTenant(pool, tenantOf(me), async (db) => {
        const target = (await db.query<{ role: Role }>(`SELECT role FROM app.users WHERE id = $1 FOR UPDATE`, [p.id])).rows[0];
        if (!target) throw new HttpError(404, 'not_found', 'User not found');
        if ((target.role === 'owner' || body.role === 'owner') && me.role !== 'owner') {
          throw new HttpError(403, 'forbidden', 'Only an owner can change an owner');
        }
        const { rows } = await db.query(
          `UPDATE app.users SET role = coalesce($2, role), is_active = coalesce($3, is_active)
            WHERE id = $1 RETURNING id, full_name, email, role, is_active, last_login_at, created_at`,
          [p.id, body.role ?? null, body.is_active ?? null],
        );
        // There must always be an active owner.
        const owners = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.users WHERE role = 'owner' AND is_active`);
        if (!owners.rows[0]!.n) throw new HttpError(400, 'last_owner', 'Keep at least one active owner');
        if (body.is_active === false) await db.query(`SELECT auth.end_user_sessions($1)`, [p.id]);
        return rows[0];
      }),
    );
  });

  // ------------------------------------------------------------ debt actions

  app.post('/api/disputes/:id/resolve', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(resolveBody, req.body ?? {}, reply);
    if (!body) return;
    return run(reply, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const d = (
          await db.query<{ debt_id: string; status: string; paid: string }>(
            `SELECT ds.debt_id, ds.status,
                    (SELECT coalesce(sum(amount), 0)::numeric(12,2)::text FROM app.payments WHERE debt_id = ds.debt_id AND status = 'approved') AS paid
               FROM app.disputes ds WHERE ds.id = $1 FOR UPDATE`,
            [p.id],
          )
        ).rows[0];
        if (!d) throw new HttpError(404, 'not_found', 'Dispute not found');
        if (d.status !== 'open') throw new HttpError(409, 'already_resolved', 'This dispute was already decided');

        const valid = body.outcome === 'debtor_right';
        await db.query(
          `UPDATE app.disputes SET status = $2, resolution_note = $3, resolved_by = app.current_user_id(), resolved_at = now() WHERE id = $1`,
          [p.id, valid ? 'resolved_valid' : 'resolved_invalid', body.note],
        );
        // Another dispute on the same debt still open keeps it disputed.
        const others = await db.query(`SELECT 1 FROM app.disputes WHERE debt_id = $1 AND status = 'open' LIMIT 1`, [d.debt_id]);
        if (others.rowCount) return { resolved: true, debt_status: 'disputed' };

        if (!valid) {
          await db.query(`UPDATE app.debts SET status = ${RESUME_STATUS} WHERE id = $1`, [d.debt_id]);
        } else if (body.action === 'close') {
          await db.query(`UPDATE app.debts SET status = 'closed' WHERE id = $1`, [d.debt_id]);
        } else if (body.action === 'pause') {
          await db.query(`UPDATE app.debts SET status = 'paused' WHERE id = $1`, [d.debt_id]);
        } else {
          if (!body.corrected_amount) throw new HttpError(400, 'invalid', 'Enter the corrected amount');
          // The corrected total owed. It cannot be less than what was already paid. Compared in SQL, never as JavaScript numbers.
          const { rows } = await db.query<{ ok: boolean }>(
            `SELECT $1::numeric(12,2) > 0 AND $1::numeric(12,2) >= $2::numeric(12,2) AS ok`,
            [body.corrected_amount, d.paid],
          );
          if (!rows[0]!.ok) throw new HttpError(400, 'invalid', `The corrected amount must be more than zero and at least SAR ${d.paid}, already paid`);
          await db.query(
            `UPDATE app.debts
                SET amount_original = $2::numeric(12,2),
                    amount_outstanding = $2::numeric(12,2) - $3::numeric(12,2)
              WHERE id = $1`,
            [d.debt_id, body.corrected_amount, d.paid],
          );
          await db.query(`UPDATE app.debts SET status = ${RESUME_STATUS} WHERE id = $1`, [d.debt_id]);
          await db.query(
            `UPDATE app.follow_up_tasks SET status = 'cancelled', skip_reason = 'debt_paid', finished_at = now()
              WHERE debt_id = $1 AND status = 'pending' AND EXISTS (SELECT 1 FROM app.debts WHERE id = $1 AND status = 'paid')`,
            [d.debt_id],
          );
        }
        const debt = await db.query(`SELECT status, amount_original, amount_outstanding FROM app.debts WHERE id = $1`, [d.debt_id]);
        return { resolved: true, debt_status: debt.rows[0].status, debt: debt.rows[0] };
      }),
    );
  });

  // Stop reminders for a debt, until a date or until someone resumes it.
  app.post('/api/debts/:id/pause', { preHandler: requireRole(EDITOR_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(pauseBody, req.body ?? {}, reply);
    if (!body) return;
    return run(reply, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const { rows } = await db.query<{ status: string }>(
          `UPDATE app.debts SET status = 'paused', paused_until = $2::date
            WHERE id = $1 AND status IN ('open', 'in_follow_up', 'promised', 'partly_paid')
            RETURNING status`,
          [p.id, body.until ?? null],
        );
        if (!rows[0]) {
          const exists = await db.query(`SELECT status FROM app.debts WHERE id = $1`, [p.id]);
          if (!exists.rowCount) throw new HttpError(404, 'not_found', 'Debt not found');
          throw new HttpError(409, 'cannot_pause', 'Only a debt in follow-up can be paused');
        }
        await db.query(
          `UPDATE app.follow_up_tasks SET status = 'cancelled', skip_reason = 'paused', finished_at = now()
            WHERE debt_id = $1 AND status = 'pending' AND task_type IN ('send_reminder', 'mark_legal_ready')`,
          [p.id],
        );
        // Why it was paused, kept for good with who and when.
        await db.query(
          `INSERT INTO audit.activity_log (client_id, actor_type, actor_id, action, target_table, target_id, details)
           VALUES (app.current_client_id(), 'user', app.current_user_id(), 'debt.paused', 'app.debts', $1,
                   jsonb_build_object('reason', $2::text, 'until', $3::text))`,
          [p.id, body.reason, body.until ?? null],
        );
        return { status: 'paused' };
      }),
    );
  });

  app.post('/api/debts/:id/resume', { preHandler: requireRole(EDITOR_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    return run(reply, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const { rows } = await db.query<{ status: string }>(
          `UPDATE app.debts SET status = ${RESUME_STATUS}, paused_until = NULL WHERE id = $1 AND status = 'paused' RETURNING status`,
          [p.id],
        );
        if (!rows[0]) {
          const exists = await db.query(`SELECT 1 FROM app.debts WHERE id = $1`, [p.id]);
          if (!exists.rowCount) throw new HttpError(404, 'not_found', 'Debt not found');
          throw new HttpError(409, 'not_paused', 'This debt is not paused');
        }
        return { status: rows[0].status };
      }),
    );
  });

  // A payment staff saw themselves (cash, a transfer in the bank statement). Approved at once, by them.
  app.post('/api/debts/:id/payments', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(paymentBody, req.body ?? {}, reply);
    if (!body) return;
    return run(reply, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const debt = (
          await db.query<{ ok: boolean; outstanding: string }>(
            `SELECT $2::numeric(12,2) > 0 AND $2::numeric(12,2) <= amount_outstanding AS ok, amount_outstanding::text AS outstanding
               FROM app.debts WHERE id = $1 FOR UPDATE`,
            [p.id, body.amount],
          )
        ).rows[0];
        if (!debt) throw new HttpError(404, 'not_found', 'Debt not found');
        if (!debt.ok) throw new HttpError(400, 'invalid', `The amount must be more than zero and at most SAR ${debt.outstanding}, still owed`);
        const { rows } = await db.query(
          `INSERT INTO app.payments (client_id, debt_id, amount, method, paid_at, status, reviewed_by, reviewed_at, extracted_details)
           VALUES (app.current_client_id(), $1, $2, $3, $4::date, 'approved', app.current_user_id(), now(),
                   CASE WHEN $5::text IS NULL THEN NULL ELSE jsonb_build_object('note', $5::text) END)
           RETURNING id, amount, method, status`,
          [p.id, body.amount, body.method, body.paid_at, body.note ?? null],
        );
        const after = await db.query(`SELECT status, amount_outstanding FROM app.debts WHERE id = $1`, [p.id]);
        return reply.code(201).send({ payment: rows[0], debt: after.rows[0] });
      }),
    );
  });
}
