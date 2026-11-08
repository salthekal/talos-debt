/**
 * Step 3.5: how much of the open debt can go straight to execution on Najiz,
 * split by instrument, and which paper notes will lose that force.
 *
 * Under the new Enforcement Law, paper promissory notes and bills of exchange
 * stay directly enforceable for one year after the law starts (types with
 * has_time_limit). Until the start date is known (ENFORCEMENT_LAW_START_DATE),
 * those debts are flagged with no deadline. A deadline typed on the instrument
 * itself (enforceable_until) wins over the general one.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { tenantOf } from '../auth.js';
import type { Config } from '../config.js';
import { withTenant } from '../db.js';
import { parseOr400 } from '../validation.js';

const OPEN = `d.status NOT IN ('paid', 'closed', 'written_off')`;

const query = z.object({ at_risk_limit: z.coerce.number().int().min(1).max(500).default(100) });

/** The general deadline for time-limited notes: one year after the law starts. */
export function paperNoteDeadline(lawStart: string | undefined): string | null {
  if (!lawStart) return null;
  const [y, m, d] = lawStart.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y + 1, m - 1, d));
  // 29 February + 1 year = 28 February, not 1 March.
  if (dt.getUTCMonth() !== m - 1) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

export function enforceabilityRoutes(app: FastifyInstance, deps: { pool: pg.Pool; config: Config }) {
  app.get('/api/enforceability', async (req, reply) => {
    const q = parseOr400(query, req.query, reply);
    if (!q) return;
    const lawStart = deps.config.ENFORCEMENT_LAW_START_DATE ?? null;
    const deadline = paperNoteDeadline(deps.config.ENFORCEMENT_LAW_START_DATE);

    return withTenant(deps.pool, tenantOf(req.user!), async (db) => {
      const totals = await db.query(
        `SELECT coalesce(sum(d.amount_outstanding), 0)::numeric(12,2) AS open_balance,
                count(*) AS open_debts,
                coalesce(sum(d.amount_outstanding) FILTER (WHERE t.directly_enforceable), 0)::numeric(12,2) AS enforceable,
                coalesce(sum(d.amount_outstanding) FILTER (WHERE t.directly_enforceable AND t.has_time_limit), 0)::numeric(12,2)
                  AS enforceable_time_limited,
                coalesce(sum(d.amount_outstanding) FILTER (WHERE NOT coalesce(t.directly_enforceable, false)), 0)::numeric(12,2)
                  AS needs_court_case,
                count(*) FILTER (WHERE i.id IS NULL) AS debts_without_instrument
           FROM app.debts d
           LEFT JOIN app.instruments i ON i.id = d.instrument_id
           LEFT JOIN app.instrument_types t ON t.code = i.type_code
          WHERE ${OPEN}`,
      );
      const t = totals.rows[0];
      const share =
        Number(t.open_balance) > 0
          ? Math.round((10000 * Number(t.enforceable)) / Number(t.open_balance)) / 100
          : null;

      const byType = await db.query(
        `SELECT coalesce(t.code, 'none') AS type_code,
                coalesce(t.name_en, 'No instrument') AS name_en,
                coalesce(t.name_ar, 'لا يوجد سند') AS name_ar,
                t.najiz_main_type, t.najiz_sub_type,
                coalesce(t.directly_enforceable, false) AS directly_enforceable,
                coalesce(t.has_time_limit, false) AS has_time_limit,
                count(*) AS debts,
                sum(d.amount_outstanding)::numeric(12,2) AS open_balance
           FROM app.debts d
           LEFT JOIN app.instruments i ON i.id = d.instrument_id
           LEFT JOIN app.instrument_types t ON t.code = i.type_code
          WHERE ${OPEN}
          GROUP BY 1, 2, 3, 4, 5, 6, 7, t.sort_order
          ORDER BY coalesce(t.directly_enforceable, false) DESC, sum(d.amount_outstanding) DESC`,
      );

      // Debts on paper notes (and bills of exchange) that will lose direct force.
      const atRisk = await db.query(
        `SELECT d.id AS debt_id, d.ref_code, d.amount_outstanding, d.status,
                dr.id AS debtor_id, dr.ref_code AS debtor_ref, dr.full_name,
                i.id AS instrument_id, i.type_code, i.reference_number, i.issue_date,
                to_char(coalesce(i.enforceable_until, $1::date), 'YYYY-MM-DD') AS deadline,
                (coalesce(i.enforceable_until, $1::date) - (now() AT TIME ZONE 'Asia/Riyadh')::date) AS days_left
           FROM app.debts d
           JOIN app.debtors dr ON dr.id = d.debtor_id
           JOIN app.instruments i ON i.id = d.instrument_id
           JOIN app.instrument_types t ON t.code = i.type_code
          WHERE ${OPEN} AND t.has_time_limit
          ORDER BY coalesce(i.enforceable_until, $1::date) NULLS LAST, d.amount_outstanding DESC
          LIMIT $2`,
        [deadline, q.at_risk_limit],
      );
      const atRiskCount = await db.query<{ count: string; amount: string }>(
        `SELECT count(*), coalesce(sum(d.amount_outstanding), 0)::numeric(12,2) AS amount
           FROM app.debts d
           JOIN app.instruments i ON i.id = d.instrument_id
           JOIN app.instrument_types t ON t.code = i.type_code
          WHERE ${OPEN} AND t.has_time_limit`,
      );

      return {
        law_start_date: lawStart,
        paper_note_deadline: deadline,
        totals: { ...t, enforceable_share_pct: share },
        by_type: byType.rows,
        paper_notes_at_risk: {
          debts: Number(atRiskCount.rows[0]!.count),
          amount: atRiskCount.rows[0]!.amount,
          note: deadline
            ? `Paper promissory notes stay directly enforceable until ${deadline}. Replace them with Nafith notes or file before then.`
            : 'The start date of the new Enforcement Law is not published yet. Paper promissory notes will stay directly enforceable for one year after it, so plan to replace them with Nafith notes.',
          items: atRisk.rows.map((r) => ({ ...r, days_left: r.days_left === null ? null : Number(r.days_left) })),
        },
        without_instrument: {
          debts: Number(t.debts_without_instrument),
          note: 'Debts with no instrument need a court case before execution, or a payment plan backed by a new Nafith promissory note.',
        },
      };
    });
  });
}
