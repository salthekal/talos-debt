/**
 * Filing on Najiz from Talos (5.4): the dashboard starts a run, follows it,
 * and can stop it. The Najiz worker (`npm run najiz`) does the work.
 *
 *   POST /api/najiz/runs             start one Najiz sign-in that files the chosen approved debts
 *   GET  /api/najiz/runs/:id         where the run stands (polled by the dashboard)
 *   POST /api/najiz/runs/:id/cancel  stop it; nothing more is sent
 *
 * Only notes approved by the client (5.2) can be filed, with nothing missing,
 * one sign-in at a time per client (najiz_runs_one_active, migration 0009).
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { REVIEWER_ROLES, requireRole, tenantOf } from '../auth.js';
import { withTenant } from '../db.js';
import { loadRows, missingOf } from '../legal/case.js';
import { loadRunView, stopRun } from '../najiz/runs.js';
import { idParam, parseOr400 } from '../validation.js';

const startBody = z.object({
  debt_ids: z.array(z.uuid()).min(1).max(20).refine((x) => new Set(x).size === x.length, 'Each debt once'),
  /**
   * A note from an earlier run may already be on Najiz (Talos stopped after
   * pressing send). Staff confirm they checked Najiz and it is not there.
   */
  checked_not_on_najiz: z.boolean().optional(),
});

export function najizRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.post('/api/najiz/runs', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const body = parseOr400(startBody, req.body ?? {}, reply);
    if (!body) return;
    const user = req.user!;
    const result = await withTenant(pool, tenantOf(user), async (db) => {
      // Lock the debts, so two people starting at once cannot file the same note twice.
      const found = await db.query(`SELECT id FROM app.debts WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [body.debt_ids]);
      if (found.rowCount !== body.debt_ids.length) return { code: 404 as const };
      const cases: string[] = [];
      for (const debtId of body.debt_ids) {
        const [r] = await loadRows(db, debtId);
        if (!r || r.case_status !== 'approved' || r.najiz_request_number) {
          return { code: 409 as const, error: 'not_approved', message: 'Only approved notes that are not on Najiz yet can be filed' };
        }
        const missing = missingOf(r);
        if (missing.length) {
          return { code: 409 as const, error: 'najiz_details_missing', message: 'Fill in what Najiz needs before filing', missing, debt_id: debtId };
        }
        cases.push(r.case_id!);
      }
      const maybe = await db.query(
        `SELECT ri.id FROM app.najiz_run_items ri JOIN app.najiz_runs nr ON nr.id = ri.run_id
          WHERE ri.legal_case_id = ANY($1) AND ri.step = 'sending' AND nr.finished_at IS NOT NULL`,
        [cases],
      );
      if (maybe.rowCount) {
        if (!body.checked_not_on_najiz) {
          return {
            code: 409 as const, error: 'najiz_check_first',
            message: 'A note may already be on Najiz from an earlier try. Check Najiz first: if it is there, add its request number by hand.',
          };
        }
        await db.query(
          `UPDATE app.najiz_run_items SET step = 'stopped', error = 'Staff checked Najiz: not sent', updated_at = now()
            WHERE id = ANY($1)`,
          [maybe.rows.map((x) => x.id)],
        );
      }
      const run = (await db.query(
        `INSERT INTO app.najiz_runs (client_id, kind, requested_by) VALUES (app.current_client_id(), 'file', $1) RETURNING id`,
        [user.userId],
      )).rows[0];
      for (const [position, caseId] of cases.entries()) {
        await db.query(
          `INSERT INTO app.najiz_run_items (client_id, run_id, legal_case_id, position) VALUES (app.current_client_id(), $1, $2, $3)`,
          [run.id, caseId, position],
        );
      }
      return { code: 201 as const, run: await loadRunView(db, run.id) };
    }).catch((err: { code?: string; constraint?: string }) => {
      if (err.code === '23505' && err.constraint === 'najiz_runs_one_active') {
        return { code: 409 as const, error: 'najiz_busy', message: 'A Najiz sign-in for your company is already running. Wait for it to finish.' };
      }
      throw err;
    });
    if (result.code === 404) return reply.code(404).send({ error: 'not_found', message: 'Debt not found' });
    if (result.code === 409) {
      const { code: _c, ...rest } = result;
      return reply.code(409).send(rest);
    }
    return reply.code(201).send({ run: result.run });
  });

  app.get('/api/najiz/runs/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const run = await withTenant(pool, tenantOf(req.user!), (db) => loadRunView(db, p.id));
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Sign-in not found' });
    return { run };
  });

  app.post('/api/najiz/runs/:id/cancel', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const run = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const exists = await db.query(`SELECT 1 FROM app.najiz_runs WHERE id = $1`, [p.id]);
      if (!exists.rowCount) return undefined;
      // A note whose "send" was already pressed is finished by the worker and saved.
      await stopRun(db, p.id, 'cancelled', 'Stopped by staff');
      return loadRunView(db, p.id);
    });
    if (!run) return reply.code(404).send({ error: 'not_found', message: 'Sign-in not found' });
    return { run };
  });
}

