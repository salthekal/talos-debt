import type pg from 'pg';
import { withTenant } from '../db.js';
import { loadSchedulerRules } from './rules.js';
import { addDays, afterDays, latest, nextWorkingTime, zonedTime } from './time.js';

/** Any number, the same in every worker, so only one of them plans at a time. */
const PLANNER_LOCK = 7_011_086_456;

export interface PlanResult {
  reminders: number;
  legal: number;
  promiseChecks: number;
  /** Another worker was already planning. */
  busy?: boolean;
}

interface Candidate {
  client_id: string;
  debt_id: string;
  attempts_count: number;
  last_contact_at: Date | null;
  last_reply_at: Date | null;
  max_attempts: number;
}

interface PromiseCandidate {
  client_id: string;
  debt_id: string;
  promised_date: string;
}

/**
 * Find debts with no next step and plan one (step 2.2):
 *
 *  - active debts with attempts left get a reminder, one interval after the
 *    last reminder or reply (or now, for a debt never contacted);
 *  - active debts with no attempts left get the legal step, one interval
 *    after the last reminder, unless that was already tried since the last
 *    reminder or reply (a person then decides);
 *  - every open promise gets a check, on the morning after its grace days.
 *
 * Debts that are promised, disputed, paused, paid or in legal are left alone,
 * as are debtors who are not active, debtors with no WhatsApp number, and
 * debts whose last reminder failed in the past day (staff were told, and
 * retrying every few minutes would only repeat the alert).
 *
 * The cross-client search uses the worker connection; the tasks themselves
 * are written inside withTenant, one client at a time.
 */
export async function planTasks(
  deps: { pool: pg.Pool; workerPool: pg.Pool; now: () => Date },
  limit = 500,
): Promise<PlanResult> {
  const lock = await deps.workerPool.connect();
  try {
    await lock.query('BEGIN');
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [PLANNER_LOCK]);
    if (!got.rows[0]?.ok) {
      await lock.query('ROLLBACK');
      return { reminders: 0, legal: 0, promiseChecks: 0, busy: true };
    }
    const result = await plan(deps, limit);
    await lock.query('COMMIT');
    return result;
  } catch (err) {
    await lock.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    lock.release();
  }
}

async function plan(deps: { pool: pg.Pool; workerPool: pg.Pool; now: () => Date }, limit: number): Promise<PlanResult> {
  const now = deps.now();
  const debts = (
    await deps.workerPool.query<Candidate>(
      `SELECT d.client_id, d.id AS debt_id, d.attempts_count, d.last_contact_at, d.last_reply_at,
              coalesce(r.max_attempts, 5) AS max_attempts
         FROM app.debts d
         JOIN app.clients c  ON c.id = d.client_id AND c.status = 'active'
         JOIN app.debtors dr ON dr.id = d.debtor_id AND dr.status = 'active'
         LEFT JOIN app.follow_up_rules r ON r.client_id = d.client_id
        WHERE d.status IN ('open', 'in_follow_up', 'partly_paid')
          AND d.amount_outstanding > 0
          AND (d.paused_until IS NULL OR d.paused_until <= ($1::timestamptz AT TIME ZONE c.timezone)::date)
          AND EXISTS (SELECT 1 FROM app.debtor_phones p
                       WHERE p.debtor_id = d.debtor_id AND p.status = 'active' AND p.has_whatsapp IS NOT FALSE)
          AND NOT EXISTS (SELECT 1 FROM app.follow_up_tasks t
                           WHERE t.debt_id = d.id AND t.status IN ('pending', 'running'))
          AND NOT EXISTS (SELECT 1 FROM app.promises p WHERE p.debt_id = d.id AND p.status = 'pending')
          AND NOT EXISTS (SELECT 1 FROM app.follow_up_tasks t
                           WHERE t.debt_id = d.id AND t.task_type = 'send_reminder' AND t.status = 'failed'
                             AND t.finished_at > $1::timestamptz - interval '1 day')
          AND (d.attempts_count < coalesce(r.max_attempts, 5)
               OR NOT EXISTS (SELECT 1 FROM app.follow_up_tasks t
                               WHERE t.debt_id = d.id AND t.task_type = 'mark_legal_ready'
                                 AND coalesce(t.finished_at, t.created_at) >= greatest(d.last_contact_at, d.last_reply_at)))
        ORDER BY d.client_id, d.created_at
        LIMIT $2`,
      [now, limit],
    )
  ).rows;

  const promises = (
    await deps.workerPool.query<PromiseCandidate>(
      `SELECT DISTINCT ON (p.debt_id) p.client_id, p.debt_id, p.promised_date::text
         FROM app.promises p
         JOIN app.clients c ON c.id = p.client_id AND c.status = 'active'
        WHERE p.status = 'pending'
          AND NOT EXISTS (SELECT 1 FROM app.follow_up_tasks t
                           WHERE t.debt_id = p.debt_id AND t.task_type = 'promise_check'
                             AND t.status IN ('pending', 'running'))
        ORDER BY p.debt_id, p.created_at DESC
        LIMIT $1`,
      [limit],
    )
  ).rows;

  const byClient = new Map<string, { debts: Candidate[]; promises: PromiseCandidate[] }>();
  for (const d of debts) {
    const entry = byClient.get(d.client_id) ?? { debts: [], promises: [] };
    entry.debts.push(d);
    byClient.set(d.client_id, entry);
  }
  for (const p of promises) {
    const entry = byClient.get(p.client_id) ?? { debts: [], promises: [] };
    entry.promises.push(p);
    byClient.set(p.client_id, entry);
  }

  const result: PlanResult = { reminders: 0, legal: 0, promiseChecks: 0 };
  for (const [clientId, work] of byClient) {
    await withTenant(deps.pool, { clientId, actorType: 'system' }, async (db) => {
      const rules = await loadSchedulerRules(db);
      const soonest = nextWorkingTime(now, rules);
      for (const d of work.debts) {
        const reminder = d.attempts_count < rules.max_attempts;
        // Reminders wait one interval after the last reminder or reply; the legal step one interval after the last reminder.
        const base = reminder ? latest(d.last_contact_at, d.last_reply_at) : d.last_contact_at;
        const planned = base ? afterDays(base, rules.interval_days, rules) : soonest;
        const due = planned > soonest ? planned : soonest;
        const inserted = await db.query(
          `INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, attempt_number, due_at)
           VALUES (app.current_client_id(), $1, $2, $3, $4)
           ON CONFLICT (client_id, debt_id, task_type)
             WHERE status IN ('pending', 'running') AND task_type IN ('send_reminder', 'mark_legal_ready')
           DO NOTHING`,
          [d.debt_id, reminder ? 'send_reminder' : 'mark_legal_ready', reminder ? d.attempts_count + 1 : null, due],
        );
        if (inserted.rowCount) {
          if (reminder) result.reminders++;
          else result.legal++;
        }
      }
      for (const p of work.promises) {
        // 10:00 client time on the day after the grace days, or now if that has passed.
        const check = zonedTime(addDays(p.promised_date, rules.promise_grace_days), '10:00', rules.timezone);
        await db.query(
          `INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, due_at)
           VALUES (app.current_client_id(), $1, 'promise_check', $2)`,
          [p.debt_id, check > now ? check : now],
        );
        result.promiseChecks++;
      }
    });
  }
  return result;
}
