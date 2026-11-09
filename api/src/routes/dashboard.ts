import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { tenantOf } from '../auth.js';
import { withTenant } from '../db.js';
import { idParam, parseOr400 } from '../validation.js';

const DEBT_STATUSES = [
  'open', 'in_follow_up', 'promised', 'partly_paid', 'paid', 'disputed',
  'paused', 'legal_ready', 'in_legal', 'written_off', 'closed',
] as const;

const debtsQuery = z.object({
  status: z.enum(DEBT_STATUSES).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Read endpoints for the client dashboard and CRM. */
export function dashboardRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/me', async (req) => {
    const user = req.user!;
    return withTenant(pool, tenantOf(user), async (db) => {
      const { rows } = await db.query(
        `SELECT id, legal_name, trade_name, sector, plan, status FROM app.clients WHERE id = $1`,
        [user.clientId],
      );
      return { user: { id: user.userId, fullName: user.fullName, role: user.role }, client: rows[0] ?? null };
    });
  });

  // Main numbers at the top of the dashboard.
  app.get('/api/dashboard/totals', async (req) => {
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `SELECT total_owed, recovered,
                coalesce(promised, 0)::numeric(12,2) AS promised,
                coalesce(disputed, 0)::numeric(12,2) AS disputed,
                coalesce(in_legal, 0)::numeric(12,2) AS in_legal,
                open_balance, enforceable_share_pct, paper_notes_at_risk
           FROM app.v_client_totals`,
      );
      return (
        rows[0] ?? {
          total_owed: '0.00', recovered: '0.00', promised: '0.00', disputed: '0.00',
          in_legal: '0.00', open_balance: '0.00', enforceable_share_pct: null, paper_notes_at_risk: 0,
        }
      );
    });
  });

  // Debt list with filters (the CRM main table).
  app.get('/api/debts', async (req, reply) => {
    const q = parseOr400(debtsQuery, req.query, reply);
    if (!q) return;
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`status = $${params.length}`);
      }
      if (q.search) {
        params.push(`%${q.search}%`);
        where.push(`(full_name ILIKE $${params.length} OR ref_code ILIKE $${params.length})`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = await db.query<{ count: string }>(
        `SELECT count(*) FROM app.v_debt_overview ${whereSql}`,
        params,
      );
      params.push(q.limit, q.offset);
      const { rows } = await db.query(
        `SELECT * FROM app.v_debt_overview ${whereSql}
          ORDER BY last_contact_at DESC NULLS LAST, ref_code
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: Number(total.rows[0]?.count ?? 0), limit: q.limit, offset: q.offset, items: rows };
    });
  });

  // One debtor: profile, phones, debts and the full timeline.
  app.get('/api/debtors/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const result = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const debtor = await db.query(
        `SELECT id, ref_code, debtor_kind, id_type, id_number, full_name, full_name_ar, nationality,
                preferred_language, employment_status, status, notes, created_at
           FROM app.debtors WHERE id = $1`,
        [p.id],
      );
      if (!debtor.rows[0]) return undefined;
      // One connection runs one query at a time, so these run in sequence.
      const phones = await db.query(
          `SELECT id, phone_e164, label, is_primary, has_whatsapp, status
             FROM app.debtor_phones WHERE debtor_id = $1 ORDER BY is_primary DESC, created_at`,
          [p.id],
        );
      const debts = await db.query(`SELECT * FROM app.v_debt_overview WHERE debtor_id = $1 ORDER BY ref_code`, [p.id]);
      // Amounts inside jsonb would become JSON numbers: cast them to text, like every other amount.
      const timeline = await db.query(
          `SELECT * FROM (
             SELECT 'message' AS kind, m.id, m.debt_id, m.created_at AS at,
                    jsonb_build_object('direction', m.direction, 'channel', m.channel, 'body', m.body,
                                       'status', m.status, 'ai_generated', m.ai_generated) AS data
               FROM app.messages m WHERE m.debtor_id = $1
             UNION ALL
             SELECT 'payment', pay.id, pay.debt_id, pay.created_at,
                    jsonb_build_object('amount', pay.amount::text, 'method', pay.method, 'status', pay.status,
                                       'rejection_reason', pay.rejection_reason)
               FROM app.payments pay JOIN app.debts d ON d.id = pay.debt_id WHERE d.debtor_id = $1
             UNION ALL
             SELECT 'promise', pr.id, pr.debt_id, pr.created_at,
                    jsonb_build_object('promised_amount', pr.promised_amount::text,
                                       'promised_date', pr.promised_date, 'status', pr.status)
               FROM app.promises pr JOIN app.debts d ON d.id = pr.debt_id WHERE d.debtor_id = $1
             UNION ALL
             SELECT 'dispute', ds.id, ds.debt_id, ds.created_at,
                    jsonb_build_object('reason', ds.reason, 'status', ds.status,
                                       'resolution_note', ds.resolution_note)
               FROM app.disputes ds JOIN app.debts d ON d.id = ds.debt_id WHERE d.debtor_id = $1
           ) t ORDER BY at DESC`,
          [p.id],
        );
      return { debtor: debtor.rows[0], phones: phones.rows, debts: debts.rows, timeline: timeline.rows };
    });
    if (!result) return reply.code(404).send({ error: 'not_found', message: 'Debtor not found' });
    return result;
  });

  // Everything waiting for a person: payment proofs to review and open disputes.
  app.get('/api/approvals', async (req) => {
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const payments = await db.query(
          `SELECT pay.id, pay.amount, pay.method, pay.paid_at, pay.extracted_details, pay.ai_match_confidence,
                  pay.proof_document_id, pay.created_at,
                  d.id AS debt_id, d.ref_code AS debt_ref, d.amount_outstanding,
                  dr.id AS debtor_id, dr.full_name
             FROM app.payments pay
             JOIN app.debts d ON d.id = pay.debt_id
             JOIN app.debtors dr ON dr.id = d.debtor_id
            WHERE pay.status = 'pending_approval'
            ORDER BY pay.created_at`,
        );
      const disputes = await db.query(
          `SELECT ds.id, ds.reason, ds.created_at,
                  d.id AS debt_id, d.ref_code AS debt_ref, d.amount_outstanding,
                  dr.id AS debtor_id, dr.full_name
             FROM app.disputes ds
             JOIN app.debts d ON d.id = ds.debt_id
             JOIN app.debtors dr ON dr.id = d.debtor_id
            WHERE ds.status = 'open'
            ORDER BY ds.created_at`,
        );
      return { payments: payments.rows, disputes: disputes.rows };
    });
  });
}
