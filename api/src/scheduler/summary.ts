import type pg from 'pg';
import { withTenant } from '../db.js';
import { loadSchedulerRules } from './rules.js';
import { localDate, localTime, weekday } from './time.js';

/** Marks a daily summary in app.notifications (target_table), so each day gets exactly one. */
export const SUMMARY_MARK = 'daily_summary';

export interface SummaryCounts {
  reminders_sent: number;
  replies: number;
  promises: number;
  payments_to_review: number;
  disputes: number;
  legal_ready: number;
  waiting_approval: number;
}

/** "12 reminders sent, 3 replies, ..." with only the parts that are not zero. */
export function summaryTitle(day: string, c: SummaryCounts): string {
  const part = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const parts = [
    part(c.reminders_sent, 'reminder sent', 'reminders sent'),
    part(c.replies, 'reply', 'replies'),
    part(c.promises, 'promise to pay', 'promises to pay'),
    part(c.disputes, 'new dispute', 'new disputes'),
    part(c.legal_ready, 'debt ready for legal', 'debts ready for legal'),
    part(c.payments_to_review, 'payment to review', 'payments to review'),
    part(c.waiting_approval, 'reminder waiting for your approval', 'reminders waiting for your approval'),
  ].filter(Boolean);
  return `Daily summary for ${day}: ${parts.length ? parts.join(', ') : 'nothing new'}`;
}

/**
 * Step 2.5: once a day, on working days, from `atTime` client time, each
 * active client gets one notification summing up what happened since the
 * last summary (or the last 24 hours).
 */
export async function sendDailySummaries(
  deps: { pool: pg.Pool; workerPool: pg.Pool; now: () => Date },
  atTime: string,
): Promise<number> {
  const now = deps.now();
  const clients = (
    await deps.workerPool.query<{ id: string }>(`SELECT id FROM app.clients WHERE status = 'active' ORDER BY id`)
  ).rows;

  let sent = 0;
  for (const { id } of clients) {
    const made = await withTenant(deps.pool, { clientId: id, actorType: 'system' }, async (db) => {
      const rules = await loadSchedulerRules(db);
      const day = localDate(now, rules.timezone);
      if (!rules.working_days.includes(weekday(day)) || localTime(now, rules.timezone) < atTime) return false;

      // One per client per local day. The advisory lock stops two workers making it at the same moment.
      await db.query(`SELECT pg_advisory_xact_lock(hashtext('daily_summary:' || app.current_client_id()::text))`);
      const last = (
        await db.query<{ created_at: Date; day: string }>(
          `SELECT n.created_at, (n.created_at AT TIME ZONE c.timezone)::date::text AS day
             FROM app.notifications n JOIN app.clients c ON c.id = n.client_id
            WHERE n.target_table = $1 ORDER BY n.created_at DESC LIMIT 1`,
          [SUMMARY_MARK],
        )
      ).rows[0];
      if (last?.day === day) return false;

      const since = last?.created_at ?? new Date(now.getTime() - 24 * 3600_000);
      const counts = (
        await db.query<SummaryCounts>(
          `SELECT
             (SELECT count(*) FROM app.messages
               WHERE direction = 'outbound' AND template_id IS NOT NULL
                 AND status IN ('sent', 'delivered', 'read') AND created_at >= $1)::int        AS reminders_sent,
             (SELECT count(*) FROM app.messages WHERE direction = 'inbound' AND created_at >= $1)::int AS replies,
             (SELECT count(*) FROM app.promises WHERE created_at >= $1)::int                    AS promises,
             (SELECT count(*) FROM app.payments WHERE status = 'pending_approval')::int         AS payments_to_review,
             (SELECT count(*) FROM app.disputes WHERE created_at >= $1)::int                    AS disputes,
             (SELECT count(*) FROM app.debts
               WHERE status = 'legal_ready' AND status_changed_at >= $1)::int                   AS legal_ready,
             (SELECT count(*) FROM app.follow_up_tasks t
               WHERE t.task_type = 'send_reminder' AND t.status = 'pending' AND t.approved_at IS NULL
                 AND NOT $2::boolean AND t.due_at <= $3::timestamptz + interval '1 day')::int  AS waiting_approval`,
          [since, rules.auto_send, now],
        )
      ).rows[0]!;

      // Dated with the scheduler's clock, which the "one per day" check above also uses.
      await db.query(
        `INSERT INTO app.notifications (client_id, kind, title, target_table, created_at, data)
         VALUES (app.current_client_id(), 'system', $1, $2, $3, $4)`,
        [summaryTitle(day, counts), SUMMARY_MARK, now, JSON.stringify({ event: 'summary', day, summary: counts })],
      );
      return true;
    });
    if (made) sent++;
  }
  return sent;
}
