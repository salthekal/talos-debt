import type { Db } from '../db.js';
import type { WorkingWindow } from './time.js';

/** Everything the scheduler needs from app.follow_up_rules, with the table's own defaults. */
export interface SchedulerRules extends WorkingWindow {
  interval_days: number;
  max_attempts: number;
  /** Reminders sent before a debt with no reply goes to legal. Never more than max_attempts. */
  legal_after_attempts: number;
  promise_grace_days: number;
  /** false: each reminder waits for a staff member to approve it. */
  auto_send: boolean;
}

/** The current client's rules. Call inside withTenant. */
export async function loadSchedulerRules(db: Db): Promise<SchedulerRules> {
  const { rows } = await db.query<{
    interval_days: number | null;
    max_attempts: number | null;
    legal_after_attempts: number | null;
    promise_grace_days: number | null;
    auto_send: boolean | null;
    working_hours_start: string | null;
    working_hours_end: string | null;
    working_days: number[] | null;
    timezone: string;
  }>(
    `SELECT r.interval_days, r.max_attempts, r.legal_after_attempts, r.promise_grace_days, r.auto_send,
            r.working_hours_start::text, r.working_hours_end::text, r.working_days, c.timezone
       FROM app.clients c LEFT JOIN app.follow_up_rules r ON r.client_id = c.id
      WHERE c.id = app.current_client_id()`,
  );
  const r = rows[0];
  if (!r) throw new Error('Client not found');
  const max = r.max_attempts ?? 5;
  return {
    interval_days: r.interval_days ?? 2,
    max_attempts: max,
    legal_after_attempts: Math.min(r.legal_after_attempts ?? 5, max),
    promise_grace_days: r.promise_grace_days ?? 1,
    auto_send: r.auto_send ?? false,
    working_hours_start: r.working_hours_start ?? '09:00',
    working_hours_end: r.working_hours_end ?? '20:00',
    working_days: r.working_days ?? [0, 1, 2, 3, 4],
    timezone: r.timezone,
  };
}
