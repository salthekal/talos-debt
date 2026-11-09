import type pg from 'pg';
import type { Config } from '../config.js';
import { withTenant, type Db, type TenantContext } from '../db.js';
import type { WhatsAppSender } from '../whatsapp/client.js';
import { SendBlocked, sendReminder, type ReminderPurpose } from '../whatsapp/outbound.js';
import type { ClaimedTask } from './claim.js';
import { loadSchedulerRules, type SchedulerRules } from './rules.js';
import { addDays, afterDays, localDate, nextWorkingTime, zonedTime } from './time.js';

export interface TaskDeps {
  /** API pool (talos_api): every task runs inside withTenant, so RLS and the audit log apply. */
  pool: pg.Pool;
  config: Config;
  sender: WhatsAppSender | undefined;
  now: () => Date;
}

/** What happened to a task. Returned for logs and tests. */
export type TaskOutcome =
  | { status: 'done'; note?: string }
  | { status: 'skipped'; reason: string }
  | { status: 'rescheduled'; reason: string; dueAt: Date }
  | { status: 'failed'; reason: string };

/** A failed send is tried this many times in total before the task fails. */
export const MAX_TRIES = 3;

/** Debts in these statuses never get reminders or a legal step from the scheduler. */
const ACTIVE = new Set(['open', 'in_follow_up', 'partly_paid']);

const systemCtx = (clientId: string): TenantContext => ({ clientId, actorType: 'system' });

interface DebtState {
  id: string;
  ref_code: string;
  status: string;
  amount_outstanding: string;
  amount_original: string;
  attempts_count: number;
  last_contact_at: Date | null;
  last_reply_at: Date | null;
  paused_until: string | null;
  debtor_status: string;
  debtor_name: string;
}

async function loadDebt(db: Db, debtId: string): Promise<DebtState | undefined> {
  const { rows } = await db.query<DebtState>(
    `SELECT d.id, d.ref_code, d.status, d.amount_outstanding, d.amount_original, d.attempts_count,
            d.last_contact_at, d.last_reply_at, d.paused_until::text, dr.status AS debtor_status,
            dr.full_name AS debtor_name
       FROM app.debts d JOIN app.debtors dr ON dr.id = d.debtor_id
      WHERE d.id = $1
      FOR UPDATE OF d`,
    [debtId],
  );
  return rows[0];
}

// `now` is the scheduler's clock (deps.now). Times it writes come from that
// clock, so every comparison it makes later uses the same clock.
async function finish(
  db: Db,
  now: Date,
  taskId: string,
  status: 'done' | 'skipped' | 'failed' | 'cancelled',
  extra: { reason?: string; messageId?: string; error?: string; triesUsed?: boolean } = {},
) {
  await db.query(
    `UPDATE app.follow_up_tasks
        SET status = $2, skip_reason = $3, result_message_id = coalesce($4::uuid, result_message_id),
            last_error = coalesce($5, last_error), tries = tries + $6, finished_at = $7, locked_at = NULL
      WHERE id = $1`,
    [taskId, status, extra.reason ?? null, extra.messageId ?? null, extra.error ?? null, extra.triesUsed ? 1 : 0, now],
  );
}

async function reschedule(db: Db, taskId: string, dueAt: Date, reason: string, triesUsed = false) {
  await db.query(
    `UPDATE app.follow_up_tasks
        SET status = 'pending', due_at = $2, last_error = $3, tries = tries + $4, locked_at = NULL
      WHERE id = $1`,
    [taskId, dueAt, reason, triesUsed ? 1 : 0],
  );
}

/**
 * `title` is the English text (fallback); `data` holds the facts so the
 * dashboard can show the notification in Arabic or English (migration 0007).
 */
async function notify(db: Db, kind: string, title: string, debtId: string, data: Record<string, unknown>) {
  await db.query(
    `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data)
     VALUES (app.current_client_id(), $1, $2, 'app.debts', $3, $4)`,
    [kind, title, debtId, JSON.stringify(data)],
  );
}

/**
 * Plan the next step for a debt after a reminder or a promise check:
 * another reminder while attempts are left, otherwise the legal step.
 * The unique index on open tasks makes this safe to call twice.
 */
export async function planNext(db: Db, debtId: string, attemptsSent: number, rules: SchedulerRules, dueAt: Date) {
  const [type, attempt] =
    attemptsSent < rules.max_attempts ? ['send_reminder', attemptsSent + 1] : ['mark_legal_ready', null];
  await db.query(
    `INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, attempt_number, due_at)
     VALUES (app.current_client_id(), $1, $2, $3, $4)
     ON CONFLICT (client_id, debt_id, task_type)
       WHERE status IN ('pending', 'running') AND task_type IN ('send_reminder', 'mark_legal_ready')
     DO NOTHING`,
    [debtId, type, attempt, dueAt],
  );
}

/** Which template a reminder uses. */
export function purposeFor(attemptsSent: number, maxAttempts: number): ReminderPurpose {
  if (attemptsSent === 0) return 'first_reminder';
  return attemptsSent + 1 >= maxAttempts ? 'final_notice' : 'follow_up';
}

// ---------------------------------------------------------------------------
// send_reminder
// ---------------------------------------------------------------------------

type Check =
  | { go: true; debt: DebtState; rules: SchedulerRules }
  | { go: false; outcome: TaskOutcome };

async function checkReminder(db: Db, task: ClaimedTask, now: Date): Promise<Check> {
  const rules = await loadSchedulerRules(db);
  const debt = await loadDebt(db, task.debt_id);
  const stop = async (reason: string): Promise<Check> => {
    await finish(db, now, task.id, 'skipped', { reason });
    return { go: false, outcome: { status: 'skipped', reason } };
  };
  const later = async (dueAt: Date, reason: string): Promise<Check> => {
    await reschedule(db, task.id, dueAt, reason);
    return { go: false, outcome: { status: 'rescheduled', reason, dueAt } };
  };

  if (!debt) return stop('not_found');
  if (debt.amount_outstanding === '0.00') return stop('debt_paid');
  if (debt.status === 'promised') return stop('promise_pending');
  if (!ACTIVE.has(debt.status)) return stop(`debt_${debt.status}`);
  if (debt.debtor_status !== 'active') return stop(`debtor_${debt.debtor_status}`);

  const today = localDate(now, rules.timezone);
  if (debt.paused_until && debt.paused_until > today) {
    return later(nextWorkingTime(zonedTime(debt.paused_until, '00:00', rules.timezone), rules), 'paused_until');
  }
  // Any open promise holds reminders until its check decides (the planner makes sure every
  // open promise has a check).
  const promise = await db.query(`SELECT 1 FROM app.promises WHERE debt_id = $1 AND status = 'pending' LIMIT 1`, [debt.id]);
  if (promise.rowCount) return stop('promise_pending');
  if (debt.attempts_count >= rules.max_attempts) return stop('max_attempts');

  // Someone sent a reminder after this task was planned (for example a staff member by hand):
  // wait a full interval from that one instead of sending another.
  if (debt.last_contact_at && debt.last_contact_at > task.created_at) {
    const due = afterDays(debt.last_contact_at, rules.interval_days, rules);
    if (due > now) return later(due, 'contacted_since_planned');
  }
  // The debtor wrote back after our last reminder: give the conversation a full interval.
  if (debt.last_reply_at && (!debt.last_contact_at || debt.last_reply_at > debt.last_contact_at)) {
    const due = afterDays(debt.last_reply_at, rules.interval_days, rules);
    if (due > now) return later(due, 'debtor_replied');
  }
  const open = nextWorkingTime(now, rules);
  if (open > now) return later(open, 'outside_working_hours');

  return { go: true, debt, rules };
}

async function runSendReminder(deps: TaskDeps, task: ClaimedTask): Promise<TaskOutcome> {
  const ctx = systemCtx(task.client_id);
  const now = deps.now();
  const check = await withTenant(deps.pool, ctx, (db) => checkReminder(db, task, now));
  if (!check.go) return check.outcome;
  const { debt, rules } = check;

  // Meta is called outside any transaction (inside sendReminder).
  const outbound = { pool: deps.pool, config: deps.config, sender: deps.sender, now: deps.now };
  const purpose = purposeFor(debt.attempts_count, rules.max_attempts);
  let result: Awaited<ReturnType<typeof sendReminder>>;
  try {
    try {
      result = await sendReminder(outbound, ctx, debt.id, purpose);
    } catch (err) {
      // No final notice template yet: use the normal follow-up one.
      if (err instanceof SendBlocked && err.code === 'no_template' && purpose === 'final_notice') {
        result = await sendReminder(outbound, ctx, debt.id, 'follow_up');
      } else {
        throw err;
      }
    }
  } catch (err) {
    if (!(err instanceof SendBlocked)) throw err;
    return withTenant(deps.pool, ctx, async (db): Promise<TaskOutcome> => {
      switch (err.code) {
        case 'outside_working_hours': {
          const due = nextWorkingTime(now, rules);
          await reschedule(db, task.id, due, err.code);
          return { status: 'rescheduled', reason: err.code, dueAt: due };
        }
        case 'not_found':
        case 'debt_not_active':
        case 'debtor_not_contactable':
          await finish(db, now, task.id, 'skipped', { reason: err.code });
          return { status: 'skipped', reason: err.code };
        default: {
          // no_active_phone, no_template, not_configured: staff must fix something first.
          await finish(db, now, task.id, 'failed', { reason: err.code, error: err.message, triesUsed: true });
          await notify(db, 'system', `Reminder for ${debt.ref_code} (${debt.debtor_name}) was not sent: ${err.message}`, debt.id, {
            event: 'not_sent', name: debt.debtor_name, ref: debt.ref_code, problem: err.code,
          });
          return { status: 'failed', reason: err.code };
        }
      }
    });
  }

  return withTenant(deps.pool, ctx, async (db): Promise<TaskOutcome> => {
    if (result.status === 'sent') {
      await finish(db, now, task.id, 'done', { messageId: result.messageId, triesUsed: true });
      const sentCount = debt.attempts_count + 1;
      await planNext(db, debt.id, sentCount, rules, afterDays(now, rules.interval_days, rules));
      return { status: 'done', note: `attempt ${sentCount} of ${rules.max_attempts}` };
    }
    // Meta refused or could not be reached.
    if (result.retryable && task.tries + 1 < MAX_TRIES) {
      const due = nextWorkingTime(new Date(now.getTime() + 15 * 60_000 * (task.tries + 1)), rules);
      await reschedule(db, task.id, due, `meta_${result.errorCode}`, true);
      return { status: 'rescheduled', reason: `meta_${result.errorCode}`, dueAt: due };
    }
    await finish(db, now, task.id, 'failed', {
      reason: 'send_failed',
      messageId: result.messageId,
      error: `${result.errorCode}: ${result.errorMessage ?? ''}`.slice(0, 500),
      triesUsed: true,
    });
    await notify(db, 'system', `Reminder for ${debt.ref_code} (${debt.debtor_name}) could not be sent by WhatsApp`, debt.id, {
      event: 'send_failed', name: debt.debtor_name, ref: debt.ref_code,
    });
    return { status: 'failed', reason: 'send_failed' };
  });
}

// ---------------------------------------------------------------------------
// promise_check
// ---------------------------------------------------------------------------

interface PromiseRow {
  id: string;
  promised_amount: string | null;
  promised_date: string;
  created_at: Date;
}

async function runPromiseCheck(deps: TaskDeps, task: ClaimedTask): Promise<TaskOutcome> {
  const now = deps.now();
  return withTenant(deps.pool, systemCtx(task.client_id), async (db): Promise<TaskOutcome> => {
    const rules = await loadSchedulerRules(db);
    const debt = await loadDebt(db, task.debt_id);
    if (!debt) {
      await finish(db, now, task.id, 'skipped', { reason: 'not_found' });
      return { status: 'skipped', reason: 'not_found' };
    }
    const today = localDate(now, rules.timezone);
    const lastDueDay = addDays(today, -rules.promise_grace_days);

    const pending = (
      await db.query<PromiseRow>(
        `SELECT id, promised_amount, promised_date::text, created_at
           FROM app.promises WHERE debt_id = $1 AND status = 'pending'
          ORDER BY created_at DESC`,
        [debt.id],
      )
    ).rows;
    const latestPromise = pending[0];
    if (!latestPromise) {
      await finish(db, now, task.id, 'skipped', { reason: 'no_pending_promise' });
      return { status: 'skipped', reason: 'no_pending_promise' };
    }
    // The newest promise is not due yet: it has its own check. Older ones are replaced by it.
    if (latestPromise.promised_date > lastDueDay) {
      await db.query(`UPDATE app.promises SET status = 'cancelled' WHERE debt_id = $1 AND status = 'pending' AND id <> $2`, [
        debt.id,
        latestPromise.id,
      ]);
      await finish(db, now, task.id, 'skipped', { reason: 'newer_promise' });
      return { status: 'skipped', reason: 'newer_promise' };
    }

    // A receipt is waiting for staff: check again tomorrow (staff were told when it arrived).
    const waiting = await db.query(
      `SELECT 1 FROM app.payments WHERE debt_id = $1 AND status = 'pending_approval' AND created_at >= $2 LIMIT 1`,
      [debt.id, latestPromise.created_at],
    );
    if (waiting.rowCount && task.tries < 5) {
      const due = zonedTime(addDays(today, 1), '10:00', rules.timezone);
      await reschedule(db, task.id, due, 'payment_waiting_for_approval', true);
      return { status: 'rescheduled', reason: 'payment_waiting_for_approval', dueAt: due };
    }

    // Money approved since the promise was made. Compared in SQL: amounts are never JavaScript numbers.
    const paid = (
      await db.query<{ verdict: 'kept' | 'partly_kept' | 'broken' }>(
        `SELECT CASE
                  WHEN $3::numeric = 0 THEN 'kept'
                  WHEN $2::numeric IS NOT NULL AND coalesce(sum(amount), 0) >= $2::numeric THEN 'kept'
                  WHEN coalesce(sum(amount), 0) > 0 THEN 'partly_kept'
                  ELSE 'broken'
                END AS verdict
           FROM app.payments
          WHERE debt_id = $1 AND status = 'approved' AND created_at >= $4`,
        [debt.id, latestPromise.promised_amount, debt.amount_outstanding, latestPromise.created_at],
      )
    ).rows[0]!;
    const verdict = paid.verdict;

    await db.query(`UPDATE app.promises SET status = $2 WHERE id = $1`, [latestPromise.id, verdict]);
    // Any older promises still open are replaced by this outcome.
    await db.query(`UPDATE app.promises SET status = 'cancelled' WHERE debt_id = $1 AND status = 'pending'`, [debt.id]);

    if (debt.amount_outstanding !== '0.00') {
      // Back to follow-up (partly_paid if some money came in at any time).
      await db.query(
        `UPDATE app.debts
            SET status = CASE WHEN amount_outstanding < amount_original THEN 'partly_paid' ELSE 'in_follow_up' END
          WHERE id = $1 AND status = 'promised'`,
        [debt.id],
      );
      if (verdict !== 'kept') {
        await notify(
          db,
          'promise_broken',
          verdict === 'broken'
            ? `${debt.debtor_name} did not pay by the promised date (${latestPromise.promised_date}) for ${debt.ref_code}`
            : `${debt.debtor_name} paid only part of what was promised for ${debt.ref_code}`,
          debt.id,
          { event: verdict === 'broken' ? 'promise_broken' : 'promise_partly', name: debt.debtor_name, ref: debt.ref_code, date: latestPromise.promised_date },
        );
      }
      const refreshed = (await loadDebt(db, debt.id))!;
      if (ACTIVE.has(refreshed.status) && refreshed.debtor_status === 'active') {
        await planNext(db, debt.id, refreshed.attempts_count, rules, nextWorkingTime(now, rules));
      }
    }
    await finish(db, now, task.id, 'done', { reason: `promise_${verdict}` });
    return { status: 'done', note: `promise_${verdict}` };
  });
}

// ---------------------------------------------------------------------------
// mark_legal_ready
// ---------------------------------------------------------------------------

async function runLegalReady(deps: TaskDeps, task: ClaimedTask): Promise<TaskOutcome> {
  const now = deps.now();
  return withTenant(deps.pool, systemCtx(task.client_id), async (db): Promise<TaskOutcome> => {
    const rules = await loadSchedulerRules(db);
    const debt = await loadDebt(db, task.debt_id);
    const skip = async (reason: string): Promise<TaskOutcome> => {
      await finish(db, now, task.id, 'skipped', { reason });
      return { status: 'skipped', reason };
    };
    if (!debt) return skip('not_found');
    if (debt.amount_outstanding === '0.00') return skip('debt_paid');
    if (!ACTIVE.has(debt.status)) return skip(`debt_${debt.status}`);
    if (debt.attempts_count < rules.legal_after_attempts) return skip('not_enough_attempts');

    const promise = await db.query(`SELECT 1 FROM app.promises WHERE debt_id = $1 AND status = 'pending' LIMIT 1`, [debt.id]);
    if (promise.rowCount) return skip('promise_pending');

    const waiting = await db.query(`SELECT 1 FROM app.payments WHERE debt_id = $1 AND status = 'pending_approval' LIMIT 1`, [
      debt.id,
    ]);
    if (waiting.rowCount) {
      const due = nextWorkingTime(zonedTime(addDays(localDate(now, rules.timezone), 1), '10:00', rules.timezone), rules);
      await reschedule(db, task.id, due, 'payment_waiting_for_approval');
      return { status: 'rescheduled', reason: 'payment_waiting_for_approval', dueAt: due };
    }

    // The debtor wrote back after the last reminder: a person decides, not the scheduler.
    if (debt.last_reply_at && (!debt.last_contact_at || debt.last_reply_at > debt.last_contact_at)) {
      await notify(
        db,
        'reply',
        `${debt.debtor_name} replied after the last reminder for ${debt.ref_code}: decide whether to send it to legal`,
        debt.id,
        { event: 'replied_after_last', name: debt.debtor_name, ref: debt.ref_code },
      );
      return skip('debtor_replied');
    }

    await db.query(`UPDATE app.debts SET status = 'legal_ready' WHERE id = $1`, [debt.id]);
    await db.query(
      `UPDATE app.follow_up_tasks SET status = 'cancelled', skip_reason = 'legal_ready', finished_at = $3
        WHERE debt_id = $1 AND status = 'pending' AND id <> $2`,
      [debt.id, task.id, now],
    );
    await notify(
      db,
      'legal_ready',
      `${debt.ref_code} (${debt.debtor_name}) is ready for legal: ${debt.attempts_count} reminders and no reply`,
      debt.id,
      { event: 'legal_ready', name: debt.debtor_name, ref: debt.ref_code, reminders: debt.attempts_count },
    );
    await finish(db, now, task.id, 'done', { reason: 'legal_ready' });
    return { status: 'done', note: 'legal_ready' };
  });
}

// ---------------------------------------------------------------------------

async function runCall(deps: TaskDeps, task: ClaimedTask): Promise<TaskOutcome> {
  // Voice calls come after the first version (step L.3).
  const now = deps.now();
  return withTenant(deps.pool, systemCtx(task.client_id), async (db) => {
    await finish(db, now, task.id, 'skipped', { reason: 'calls_not_available' });
    return { status: 'skipped', reason: 'calls_not_available' } as const;
  });
}

/**
 * Run one claimed task. An unexpected error (for example the database going
 * away) puts the task back for a later try, and fails it after MAX_TRIES.
 */
export async function runTask(deps: TaskDeps, task: ClaimedTask): Promise<TaskOutcome> {
  try {
    switch (task.task_type) {
      case 'send_reminder':
        return await runSendReminder(deps, task);
      case 'promise_check':
        return await runPromiseCheck(deps, task);
      case 'mark_legal_ready':
        return await runLegalReady(deps, task);
      case 'call':
        return await runCall(deps, task);
    }
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 500);
    const now = deps.now();
    return withTenant(deps.pool, systemCtx(task.client_id), async (db): Promise<TaskOutcome> => {
      if (task.tries + 1 >= MAX_TRIES) {
        await finish(db, now, task.id, 'failed', { reason: 'error', error: message, triesUsed: true });
        return { status: 'failed', reason: 'error' };
      }
      const due = new Date(deps.now().getTime() + 10 * 60_000 * (task.tries + 1));
      await reschedule(db, task.id, due, message, true);
      return { status: 'rescheduled', reason: 'error', dueAt: due };
    });
  }
}

