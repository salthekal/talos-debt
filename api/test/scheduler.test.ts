/**
 * The scheduler (Phase 2): reminders, promise checks, the legal step, daily
 * summaries, crash recovery and the staff approval routes.
 *
 * Each test starts from a fresh database. A fake clock on Sunday
 * 6 December 2026 is used, so every real timestamp in the seed is in the past.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { claimTasks } from '../src/scheduler/claim.js';
import { planTasks } from '../src/scheduler/planner.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { summaryTitle } from '../src/scheduler/summary.js';
import { purposeFor } from '../src/scheduler/tasks.js';
import { addDays, afterDays, localDate, nextWorkingTime, weekday, zonedTime } from '../src/scheduler/time.js';
import type { SendResult, TemplateMessage, TextMessage, WhatsAppSender } from '../src/whatsapp/client.js';
import { ADMIN_URL, API_URL, CLIENT, OTHER_CLIENT, OTHER_USER, STAFF } from './helpers.js';

const WORKER_URL =
  process.env.TEST_WORKER_DATABASE_URL ?? 'postgres://talos_jobs:talos_jobs_dev@localhost:5432/talos_test';
const RESET = fileURLToPath(new URL('../../scripts/db-reset.sh', import.meta.url));
const MY_PHONE = '+966511111111';

// Seed debts (dev/seed.sql)
const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001'; // 4 of 5 reminders sent
const FAHAD_DEBT = '66666666-6666-4666-8666-000000000002'; // promised
const RAHIM_DEBT = '66666666-6666-4666-8666-000000000003'; // a receipt waits for approval
const AHMED_DEBT = '66666666-6666-4666-8666-000000000004'; // disputed
const SURESH_DEBT = '66666666-6666-4666-8666-000000000005'; // partly paid, 1000.00 left
const SURESH_DEBTOR = '33333333-3333-4333-8333-000000000005';

// Riyadh is UTC+3 all year.
const riyadh = (day: string, time: string) => new Date(`${day}T${time}:00+03:00`);
const SUNDAY_10 = riyadh('2026-12-06', '10:00');

const RULES = {
  working_hours_start: '09:00',
  working_hours_end: '20:00',
  working_days: [0, 1, 2, 3, 4],
  timezone: 'Asia/Riyadh',
};

class FakeSender implements WhatsAppSender {
  templates: TemplateMessage[] = [];
  next: SendResult | (() => SendResult) = { ok: true, providerMessageId: 'x' };
  async sendTemplate(msg: TemplateMessage): Promise<SendResult> {
    this.templates.push(msg);
    const r = typeof this.next === 'function' ? this.next() : this.next;
    return r.ok ? { ok: true, providerMessageId: `wamid.sched.${this.templates.length}.${Math.random()}` } : r;
  }
  async sendText(_msg: TextMessage): Promise<SendResult> {
    return { ok: true, providerMessageId: 'wamid.text' };
  }
}

let admin: pg.Pool;
let pool: pg.Pool;
let worker: pg.Pool;
let clock: Date;
let sender: FakeSender;
const apps: FastifyInstance[] = [];

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: API_URL,
  AUTH_MODE: 'dev',
  WHATSAPP_DEV_REDIRECT_TO: MY_PHONE,
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
});

/** `null` = WhatsApp not set up. */
function makeScheduler(workerPool = worker, s: WhatsAppSender | null = sender) {
  return new Scheduler({ pool, workerPool, config, sender: s ?? undefined, now: () => clock });
}

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await admin.query<T>(sql, params)).rows;
}

const tasksOf = (debtId: string) =>
  q<{ id: string; task_type: string; status: string; skip_reason: string | null; due_at: Date; attempt_number: number | null; tries: number; last_error: string | null }>(
    `SELECT id, task_type, status, skip_reason, due_at, attempt_number, tries, last_error
       FROM app.follow_up_tasks WHERE debt_id = $1 ORDER BY created_at, id`,
    [debtId],
  );

/** Notifications in order, without the daily summary (each tick may add one). */
const notifications = (withSummary = false) =>
  q<{ kind: string; title: string; target_table: string | null }>(
    `SELECT kind, title, target_table FROM app.notifications
      WHERE $1 OR target_table IS DISTINCT FROM 'daily_summary'
      ORDER BY created_at, id`,
    [withSummary],
  );

/** Alerts about one debt. */
const notesFor = (debtId: string) =>
  q<{ kind: string; title: string }>(
    `SELECT kind, title FROM app.notifications WHERE target_table = 'app.debts' AND target_id = $1 ORDER BY created_at, id`,
    [debtId],
  );

const autoSend = (on: boolean) => q(`UPDATE app.follow_up_rules SET auto_send = $2 WHERE client_id = $1`, [CLIENT, on]);

beforeEach(async () => {
  execFileSync(RESET, { env: { ...process.env, DB_NAME: 'talos_test' }, stdio: 'ignore' });
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  pool = createPool(API_URL);
  worker = createPool(WORKER_URL);
  clock = SUNDAY_10;
  sender = new FakeSender();
  // The seed templates are drafts; treat them as approved by Meta.
  await q(`UPDATE app.message_templates SET approval_status = 'approved' WHERE client_id IS NULL`);
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  await pool.end();
  await worker.end();
  await admin.end();
});

// ---------------------------------------------------------------------------

describe('working hours and dates', () => {
  it('finds the next moment inside working hours', () => {
    expect(nextWorkingTime(SUNDAY_10, RULES)).toEqual(SUNDAY_10);
    // Friday and Saturday are off: Sunday 09:00.
    expect(nextWorkingTime(riyadh('2026-12-04', '11:00'), RULES)).toEqual(riyadh('2026-12-06', '09:00'));
    // After 20:00: next morning.
    expect(nextWorkingTime(riyadh('2026-12-07', '20:00'), RULES)).toEqual(riyadh('2026-12-08', '09:00'));
    // Before 09:00: same day at 09:00.
    expect(nextWorkingTime(riyadh('2026-12-07', '06:30'), RULES)).toEqual(riyadh('2026-12-07', '09:00'));
  });

  it('adds days on the local calendar and lands inside working hours', () => {
    expect(afterDays(SUNDAY_10, 2, RULES)).toEqual(riyadh('2026-12-08', '10:00'));
    // Thursday + 2 days = Saturday, so Sunday 09:00.
    expect(afterDays(riyadh('2026-12-10', '15:00'), 2, RULES)).toEqual(riyadh('2026-12-13', '09:00'));
    // Local date, not UTC date: 01:00 in Riyadh is still the day before in UTC.
    expect(localDate(riyadh('2026-12-07', '01:00'), 'Asia/Riyadh')).toBe('2026-12-07');
    expect(zonedTime('2026-12-07', '10:00', 'Asia/Riyadh').toISOString()).toBe('2026-12-07T07:00:00.000Z');
    expect(weekday('2026-12-06')).toBe(0);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('handles time zones with daylight saving', () => {
    // London: 10:00 is 10:00 UTC in winter and 09:00 UTC in summer.
    expect(zonedTime('2026-12-07', '10:00', 'Europe/London').toISOString()).toBe('2026-12-07T10:00:00.000Z');
    expect(zonedTime('2026-07-07', '10:00', 'Europe/London').toISOString()).toBe('2026-07-07T09:00:00.000Z');
  });

  it('picks the template for each attempt', () => {
    expect(purposeFor(0, 5)).toBe('first_reminder');
    expect(purposeFor(2, 5)).toBe('follow_up');
    expect(purposeFor(4, 5)).toBe('final_notice');
  });

  it('writes a short daily summary', () => {
    expect(
      summaryTitle('2026-12-06', {
        reminders_sent: 12, replies: 1, promises: 0, payments_to_review: 2, disputes: 0, legal_ready: 1, waiting_approval: 0,
      }),
    ).toBe('Daily summary for 2026-12-06: 12 reminders sent, 1 reply, 1 debt ready for legal, 2 payments to review');
  });
});

describe('automatic reminders (2.1, 2.2)', () => {
  it('sends due reminders to the development number and plans the next one', async () => {
    await autoSend(true);
    const result = await makeScheduler().tick({ plan: false });

    // Seed tasks for Imran, Rahim and Suresh were due.
    expect(result.ran.map((r) => r.outcome.status)).toEqual(['done', 'done', 'done']);
    expect(sender.templates).toHaveLength(3);
    expect(new Set(sender.templates.map((t) => t.to))).toEqual(new Set([MY_PHONE]));

    const suresh = await tasksOf(SURESH_DEBT);
    expect(suresh.map((t) => [t.task_type, t.status, t.attempt_number])).toEqual([
      ['send_reminder', 'done', 3],
      ['send_reminder', 'pending', 4],
    ]);
    // Next one: two days later at the same local time, inside working hours.
    expect(suresh[1]!.due_at).toEqual(riyadh('2026-12-08', '10:00'));
    const debt = (await q<{ attempts_count: number }>(`SELECT attempts_count FROM app.debts WHERE id = $1`, [SURESH_DEBT]))[0]!;
    expect(debt.attempts_count).toBe(3);

    // The sent reminder is linked to its task.
    const linked = await q(
      `SELECT 1 FROM app.follow_up_tasks t JOIN app.messages m ON m.id = t.result_message_id
        WHERE t.debt_id = $1 AND t.status = 'done' AND m.status = 'sent'`,
      [SURESH_DEBT],
    );
    expect(linked).toHaveLength(1);
  });

  it('the last reminder uses the final notice (or follow-up if there is none) and then plans the legal step', async () => {
    await autoSend(true);
    await makeScheduler().tick({ plan: false });
    const imran = await tasksOf(IMRAN_DEBT);
    expect(imran.map((t) => [t.task_type, t.status])).toEqual([
      ['send_reminder', 'done'],
      ['mark_legal_ready', 'pending'],
    ]);
    // No final_notice template in the seed: the follow-up template was used.
    const used = await q<{ purpose: string }>(
      `SELECT mt.purpose FROM app.messages m JOIN app.message_templates mt ON mt.id = m.template_id
        WHERE m.debt_id = $1 AND m.direction = 'outbound' ORDER BY m.created_at DESC LIMIT 1`,
      [IMRAN_DEBT],
    );
    expect(used[0]!.purpose).toBe('follow_up');
  });

  it('plans a first reminder for a new debt, at the next working time', async () => {
    await autoSend(true);
    clock = riyadh('2026-12-04', '12:00'); // Friday
    await q(
      `INSERT INTO app.debts (id, client_id, debtor_id, ref_code, amount_original, reason)
       VALUES ('66666666-6666-4666-8666-0000000000aa', $1, $2, 'DBT-2026-0100', 300.00, 'New fine')`,
      [CLIENT, SURESH_DEBTOR],
    );
    const plan = await planTasks({ pool, workerPool: worker, now: () => clock });
    expect(plan.reminders).toBe(1);
    const t = await tasksOf('66666666-6666-4666-8666-0000000000aa');
    expect(t).toMatchObject([{ task_type: 'send_reminder', status: 'pending', attempt_number: 1 }]);
    expect(t[0]!.due_at).toEqual(riyadh('2026-12-06', '09:00'));

    // Planning again adds nothing.
    expect((await planTasks({ pool, workerPool: worker, now: () => clock })).reminders).toBe(0);
  });

  it('does not plan for promised, disputed or paid debts, or debtors with no number', async () => {
    await q(`UPDATE app.follow_up_tasks SET status = 'cancelled' WHERE status = 'pending'`);
    await q(`UPDATE app.debtor_phones SET status = 'wrong_number' WHERE debtor_id = $1`, [SURESH_DEBTOR]);
    const plan = await planTasks({ pool, workerPool: worker, now: () => clock });
    // Imran (4 sent, attempts left) and Rahim get reminders. Fahad is promised, Ahmed disputed, Suresh has no number.
    expect(plan.reminders).toBe(2);
    expect(await tasksOf(FAHAD_DEBT)).toMatchObject([{ task_type: 'promise_check' }]);
    expect(await tasksOf(AHMED_DEBT)).toEqual([]);
    expect((await tasksOf(SURESH_DEBT)).filter((t) => t.status === 'pending')).toEqual([]);
  });

  it('only one planner runs at a time', async () => {
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(7011086456)`);
      expect(await planTasks({ pool, workerPool: worker, now: () => clock })).toMatchObject({ busy: true });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });
});

describe('stop rules at the moment of sending', () => {
  it('skips a reminder for a debt paused, closed or a debtor not to contact', async () => {
    await autoSend(true);
    await q(`UPDATE app.debts SET status = 'paused' WHERE id = $1`, [IMRAN_DEBT]);
    await q(`UPDATE app.debtors SET status = 'do_not_contact' WHERE id = '33333333-3333-4333-8333-000000000003'`);
    await q(`UPDATE app.debts SET paused_until = '2026-12-20' WHERE id = $1`, [SURESH_DEBT]);
    const result = await makeScheduler().tick({ plan: false });
    expect(sender.templates).toHaveLength(0);
    expect(result.ran.map((r) => r.outcome)).toEqual(
      expect.arrayContaining([
        { status: 'skipped', reason: 'debt_paused' },
        { status: 'skipped', reason: 'debtor_do_not_contact' },
        expect.objectContaining({ status: 'rescheduled', reason: 'paused_until' }),
      ]),
    );
    expect((await tasksOf(SURESH_DEBT))[0]!.due_at).toEqual(riyadh('2026-12-20', '09:00'));
  });

  it('a dispute or full payment cancels planned reminders (database triggers)', async () => {
    await q(
      `INSERT INTO app.disputes (client_id, debt_id, reason) VALUES ($1, $2, 'Says the bike was returned')`,
      [CLIENT, IMRAN_DEBT],
    );
    await q(
      `INSERT INTO app.payments (client_id, debt_id, amount, method, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, 1000.00, 'bank_transfer', 'approved', $3, now())`,
      [CLIENT, SURESH_DEBT, STAFF],
    );
    expect(await tasksOf(IMRAN_DEBT)).toMatchObject([{ status: 'cancelled', skip_reason: 'disputed' }]);
    expect(await tasksOf(SURESH_DEBT)).toMatchObject([{ status: 'cancelled', skip_reason: 'debt_paid' }]);
    await autoSend(true);
    await makeScheduler().tick({ plan: true });
    // Only Rahim was sent a reminder; nothing is planned again for the other two.
    expect(sender.templates).toHaveLength(1);
    expect((await tasksOf(IMRAN_DEBT)).filter((t) => t.status === 'pending')).toEqual([]);
    expect((await tasksOf(SURESH_DEBT)).filter((t) => t.status === 'pending')).toEqual([]);
  });

  it('outside working hours a reminder waits for the next working morning', async () => {
    await autoSend(true);
    clock = riyadh('2026-12-04', '11:00'); // Friday
    // Make the seed tasks due by Friday.
    await q(`UPDATE app.follow_up_tasks SET due_at = $1`, [riyadh('2026-12-04', '08:00')]);
    const result = await makeScheduler().tick({ plan: false });
    expect(sender.templates).toHaveLength(0);
    expect(result.ran.every((r) => r.outcome.status === 'rescheduled')).toBe(true);
    expect((await tasksOf(SURESH_DEBT))[0]!.due_at).toEqual(riyadh('2026-12-06', '09:00'));
  });

  it('waits a full interval after a reminder sent by hand or a reply from the debtor', async () => {
    await autoSend(true);
    // A staff member sent Suresh a reminder this morning, after the task was planned.
    await q(`UPDATE app.debts SET last_contact_at = $2 WHERE id = $1`, [SURESH_DEBT, riyadh('2026-12-06', '09:15')]);
    // Rahim wrote back an hour ago, after the last reminder.
    await q(`UPDATE app.debts SET last_contact_at = $2, last_reply_at = $3 WHERE id = $1`, [
      RAHIM_DEBT,
      riyadh('2026-12-03', '10:00'),
      riyadh('2026-12-06', '09:00'),
    ]);
    const result = await makeScheduler().tick({ plan: false });
    const reasons = result.ran.map((r) => r.outcome.status === 'rescheduled' && r.outcome.reason);
    expect(reasons).toEqual(expect.arrayContaining(['contacted_since_planned', 'debtor_replied']));
    expect((await tasksOf(RAHIM_DEBT))[0]!.due_at).toEqual(riyadh('2026-12-08', '09:00'));
    expect(sender.templates).toHaveLength(1); // only Imran
  });

  it('a suspended client gets nothing', async () => {
    await autoSend(true);
    await q(`UPDATE app.clients SET status = 'suspended' WHERE id = $1`, [CLIENT]);
    const result = await makeScheduler().tick({ plan: true });
    expect(result.ran).toEqual([]);
    expect(sender.templates).toHaveLength(0);
  });
});

describe('never two reminders for the same debt', () => {
  it('the database refuses a second open reminder for a debt', async () => {
    await expect(
      q(
        `INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, due_at) VALUES ($1, $2, 'send_reminder', now())`,
        [CLIENT, SURESH_DEBT],
      ),
    ).rejects.toThrow(/follow_up_tasks_one_open/);
  });

  it('two workers at the same time send each reminder once', async () => {
    await autoSend(true);
    const worker2 = createPool(WORKER_URL);
    try {
      const [a, b] = await Promise.all([makeScheduler().tick({ plan: false }), makeScheduler(worker2).tick({ plan: false })]);
      expect(a.ran.length + b.ran.length).toBe(3);
      expect(sender.templates).toHaveLength(3);
      const sent = await q<{ n: number }>(
        `SELECT count(*)::int AS n FROM app.messages WHERE direction = 'outbound' AND created_at > now() - interval '1 minute'`,
      );
      expect(sent[0]!.n).toBe(3);
    } finally {
      await worker2.end();
    }
  });

  it('a claimed task is not claimed again', async () => {
    const first = await claimTasks(worker, { now: clock, limit: 10, canSend: true });
    const second = await claimTasks(worker, { now: clock, limit: 10, canSend: true });
    // auto_send is off and nothing is approved: only non-reminder tasks could be claimed.
    expect(first.every((t) => t.task_type !== 'send_reminder')).toBe(true);
    expect(second).toEqual([]);
  });
});

describe('when sending fails', () => {
  it('retries a temporary Meta error, then fails and tells staff', async () => {
    await autoSend(true);
    await q(`UPDATE app.follow_up_tasks SET status = 'cancelled' WHERE debt_id <> $1`, [SURESH_DEBT]);
    sender.next = { ok: false, errorCode: '131016', errorMessage: 'Service unavailable', retryable: true };

    const first = await makeScheduler().tick({ plan: false });
    expect(first.ran[0]!.outcome).toMatchObject({ status: 'rescheduled', reason: 'meta_131016' });
    expect((await tasksOf(SURESH_DEBT))[0]).toMatchObject({ status: 'pending', tries: 1 });

    clock = riyadh('2026-12-06', '12:00');
    await makeScheduler().tick({ plan: false });
    clock = riyadh('2026-12-06', '14:00');
    const third = await makeScheduler().tick({ plan: false });
    expect(third.ran[0]!.outcome).toEqual({ status: 'failed', reason: 'send_failed' });
    expect((await tasksOf(SURESH_DEBT))[0]).toMatchObject({ status: 'failed', tries: 3 });
    expect((await notifications()).map((n) => n.title)).toContain(
      'Reminder for DBT-2026-0005 (Suresh Kumar Demo) could not be sent by WhatsApp',
    );
    // The attempt does not count, and nothing is planned again for a day (no repeated alerts).
    expect((await q<{ attempts_count: number }>(`SELECT attempts_count FROM app.debts WHERE id = $1`, [SURESH_DEBT]))[0]!.attempts_count).toBe(2);
    const sureshPending = async () => (await tasksOf(SURESH_DEBT)).filter((t) => t.status === 'pending').length;
    await planTasks({ pool, workerPool: worker, now: () => clock });
    expect(await sureshPending()).toBe(0);
    clock = riyadh('2026-12-07', '15:00');
    await planTasks({ pool, workerPool: worker, now: () => clock });
    expect(await sureshPending()).toBe(1);
  });

  it('a refused message fails at once', async () => {
    await autoSend(true);
    sender.next = { ok: false, errorCode: '131026', errorMessage: 'Not a WhatsApp number', retryable: false };
    const result = await makeScheduler().tick({ plan: false });
    expect(result.ran.every((r) => r.outcome.status === 'failed')).toBe(true);
  });

  it('a debt with no WhatsApp number fails and tells staff', async () => {
    await autoSend(true);
    await q(`UPDATE app.follow_up_tasks SET status = 'cancelled' WHERE debt_id <> $1`, [SURESH_DEBT]);
    await q(`UPDATE app.debtor_phones SET status = 'wrong_number' WHERE debtor_id = $1`, [SURESH_DEBTOR]);
    const result = await makeScheduler().tick({ plan: false });
    expect(result.ran[0]!.outcome).toEqual({ status: 'failed', reason: 'no_active_phone' });
    expect((await notifications()).at(-1)!.title).toMatch(/DBT-2026-0005.*no active WhatsApp number/);
  });

  it('without WhatsApp set up, reminders wait and other tasks still run', async () => {
    await autoSend(true);
    clock = riyadh('2026-12-13', '10:00');
    const result = await makeScheduler(worker, null).tick({ plan: true });
    expect(result.ran.map((r) => r.type)).toEqual(['promise_check']);
    expect((await tasksOf(SURESH_DEBT))[0]!.status).toBe('pending');
  });
});

describe('a worker that stopped half way (crash recovery)', () => {
  const takeAll = async () => {
    await autoSend(true);
    const claimed = await claimTasks(worker, { now: clock, limit: 10, canSend: true });
    await q(`UPDATE app.follow_up_tasks SET locked_at = now() - interval '1 hour' WHERE status = 'running'`);
    return claimed;
  };

  it('puts back a task that had not sent anything', async () => {
    await takeAll();
    const result = await makeScheduler().tick({ plan: false });
    expect(result.recovered).toEqual({ requeued: 3, closed: 0 });
    expect(sender.templates).toHaveLength(3); // sent once each, after recovery
  });

  it('never sends again when the reminder had already gone out', async () => {
    await takeAll();
    // Suresh's reminder had been sent before the worker stopped.
    await q(
      `INSERT INTO app.messages (client_id, debtor_id, debt_id, channel, direction, template_id, body, status, provider_message_id)
       VALUES ($1, $2, $3, 'whatsapp', 'outbound', '77777777-7777-4777-8777-000000000004', 'Reminder', 'sent', 'wamid.before')`,
      [CLIENT, SURESH_DEBTOR, SURESH_DEBT],
    );
    const result = await makeScheduler().tick({ plan: false });
    expect(result.recovered).toEqual({ requeued: 2, closed: 1 });
    expect((await tasksOf(SURESH_DEBT))[0]).toMatchObject({ status: 'done' });
    expect(sender.templates).toHaveLength(2); // Imran and Rahim only
  });

  it('a reminder left "queued" is not resent: staff are asked to check', async () => {
    await takeAll();
    await q(
      `INSERT INTO app.messages (client_id, debtor_id, debt_id, channel, direction, template_id, body, status)
       VALUES ($1, $2, $3, 'whatsapp', 'outbound', '77777777-7777-4777-8777-000000000004', 'Reminder', 'queued')`,
      [CLIENT, SURESH_DEBTOR, SURESH_DEBT],
    );
    await makeScheduler().tick({ plan: false });
    expect((await tasksOf(SURESH_DEBT))[0]).toMatchObject({ status: 'failed', last_error: 'worker_stopped_during_send' });
    const msg = await q<{ status: string }>(`SELECT status FROM app.messages WHERE debt_id = $1 AND body = 'Reminder'`, [SURESH_DEBT]);
    expect(msg[0]!.status).toBe('failed');
    expect((await notifications()).at(-1)!.title).toMatch(/DBT-2026-0005 may not have been sent/);
  });
});

describe('promise checks (2.3)', () => {
  // Fahad promised the full amount; the seed promise is due two days after the real date.
  const afterPromise = async () => {
    const p = (await q<{ d: string }>(`SELECT promised_date::text AS d FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]!;
    clock = riyadh(addDays(p.d, 7), '10:00');
    while (![0, 1, 2, 3, 4].includes(clock.getUTCDay())) clock = new Date(clock.getTime() + 86_400_000);
    return p.d;
  };
  const pay = (amount: string) =>
    q(
      `INSERT INTO app.payments (client_id, debt_id, amount, method, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'bank_transfer', 'approved', $4, now())`,
      [CLIENT, FAHAD_DEBT, amount, STAFF],
    );

  it('every open promise gets a check on the morning after the grace day', async () => {
    const plan = await planTasks({ pool, workerPool: worker, now: () => clock });
    expect(plan.promiseChecks).toBe(1);
    const p = (await q<{ d: string }>(`SELECT promised_date::text AS d FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]!;
    // Today's real date + 2 is in the past for the fake clock, so the check is due now.
    expect((await tasksOf(FAHAD_DEBT))[0]).toMatchObject({ task_type: 'promise_check', status: 'pending' });
    expect(p.d < localDate(clock, 'Asia/Riyadh')).toBe(true);
  });

  it('a broken promise alerts staff and restarts reminders', async () => {
    await afterPromise();
    await makeScheduler().tick({ plan: true });
    expect((await q(`SELECT status FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'broken' });
    expect((await q(`SELECT status FROM app.debts WHERE id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'in_follow_up' });
    expect((await notifications()).map((n) => n.kind)).toContain('promise_broken');
    expect((await tasksOf(FAHAD_DEBT)).map((t) => [t.task_type, t.status])).toEqual([
      ['promise_check', 'done'],
      ['send_reminder', 'pending'],
    ]);
  });

  it('a kept promise (debt paid) ends follow-up', async () => {
    await afterPromise();
    await pay('1280.50');
    await makeScheduler().tick({ plan: true });
    expect((await q(`SELECT status FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'kept' });
    expect((await q(`SELECT status FROM app.debts WHERE id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'paid' });
    expect((await tasksOf(FAHAD_DEBT)).filter((t) => t.status === 'pending')).toEqual([]);
    expect((await notifications()).map((n) => n.kind)).not.toContain('promise_broken');
  });

  it('part of the money: partly kept, and reminders continue for the rest', async () => {
    await afterPromise();
    await pay('500.00');
    await makeScheduler().tick({ plan: true });
    expect((await q(`SELECT status FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'partly_kept' });
    expect((await q(`SELECT status, amount_outstanding FROM app.debts WHERE id = $1`, [FAHAD_DEBT]))[0]).toEqual({
      status: 'partly_paid',
      amount_outstanding: '780.50',
    });
    expect((await tasksOf(FAHAD_DEBT)).at(-1)).toMatchObject({ task_type: 'send_reminder', status: 'pending' });
  });

  it('a promised amount that was paid in full counts as kept', async () => {
    await q(`UPDATE app.promises SET promised_amount = 500.00 WHERE debt_id = $1`, [FAHAD_DEBT]);
    await afterPromise();
    await pay('500.00');
    await makeScheduler().tick({ plan: true });
    expect((await q(`SELECT status FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'kept' });
  });

  it('waits while a receipt is waiting for staff approval', async () => {
    await afterPromise();
    await q(
      `INSERT INTO app.payments (client_id, debt_id, amount, method) VALUES ($1, $2, 1280.50, 'bank_transfer')`,
      [CLIENT, FAHAD_DEBT],
    );
    const result = await makeScheduler().tick({ plan: true });
    expect(result.ran.find((r) => r.type === 'promise_check')!.outcome).toMatchObject({
      status: 'rescheduled',
      reason: 'payment_waiting_for_approval',
    });
    expect((await q(`SELECT status FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'pending' });
  });

  it('a newer promise replaces the old one', async () => {
    const day = await afterPromise();
    await planTasks({ pool, workerPool: worker, now: () => clock }); // check for the old promise, due now
    await q(
      `INSERT INTO app.promises (client_id, debt_id, promised_date) VALUES ($1, $2, $3)`,
      [CLIENT, FAHAD_DEBT, addDays(day, 14)],
    );
    const result = await makeScheduler().tick({ plan: false });
    expect(result.ran.find((r) => r.type === 'promise_check')!.outcome).toEqual({ status: 'skipped', reason: 'newer_promise' });
    const promises = await q<{ status: string }>(`SELECT status FROM app.promises WHERE debt_id = $1 ORDER BY created_at`, [FAHAD_DEBT]);
    expect(promises.map((p) => p.status)).toEqual(['cancelled', 'pending']);
    expect((await q(`SELECT status FROM app.debts WHERE id = $1`, [FAHAD_DEBT]))[0]).toEqual({ status: 'promised' });
  });

  it('no reminder goes out while a promise is open', async () => {
    await autoSend(true);
    await q(`INSERT INTO app.promises (client_id, debt_id, promised_date) VALUES ($1, $2, '2026-12-10')`, [CLIENT, SURESH_DEBT]);
    await makeScheduler().tick({ plan: false });
    expect((await tasksOf(SURESH_DEBT))[0]).toMatchObject({ status: 'skipped', skip_reason: 'promise_pending' });
    expect(sender.templates).toHaveLength(2); // Imran and Rahim
  });
});

describe('ready for legal (2.4)', () => {
  const lastReminderSent = async () => {
    await q(`UPDATE app.follow_up_tasks SET status = 'cancelled' WHERE debt_id = $1`, [IMRAN_DEBT]);
    await q(`UPDATE app.debts SET attempts_count = 5, last_contact_at = $2 WHERE id = $1`, [IMRAN_DEBT, riyadh('2026-12-01', '10:00')]);
  };

  it('after the last reminder with no reply, the debt is marked ready for legal', async () => {
    await lastReminderSent();
    const plan = await planTasks({ pool, workerPool: worker, now: () => clock });
    expect(plan.legal).toBe(1);
    await makeScheduler().tick({ plan: false });
    expect((await q(`SELECT status FROM app.debts WHERE id = $1`, [IMRAN_DEBT]))[0]).toEqual({ status: 'legal_ready' });
    expect(await notesFor(IMRAN_DEBT)).toEqual([
      { kind: 'legal_ready', title: 'DBT-2026-0001 (Imran Khan Demo) is ready for legal: 5 reminders and no reply' },
    ]);
    // The database records the change in the audit log, as the system.
    const audit = await q<{ actor_type: string }>(
      `SELECT actor_type FROM audit.activity_log WHERE target_table = 'app.debts' AND target_id = $1 ORDER BY id DESC LIMIT 1`,
      [IMRAN_DEBT],
    );
    expect(audit[0]!.actor_type).toBe('system');
  });

  it('waits one interval after the last reminder', async () => {
    await lastReminderSent();
    await q(`UPDATE app.debts SET last_contact_at = $2 WHERE id = $1`, [IMRAN_DEBT, riyadh('2026-12-06', '09:30')]);
    await planTasks({ pool, workerPool: worker, now: () => clock });
    expect((await tasksOf(IMRAN_DEBT)).at(-1)).toMatchObject({ task_type: 'mark_legal_ready', status: 'pending' });
    expect((await tasksOf(IMRAN_DEBT)).at(-1)!.due_at).toEqual(riyadh('2026-12-08', '09:30'));
  });

  it('a reply after the last reminder goes to a person, and is not tried again', async () => {
    await lastReminderSent();
    await q(`UPDATE app.debts SET last_reply_at = $2 WHERE id = $1`, [IMRAN_DEBT, riyadh('2026-12-02', '10:00')]);
    await makeScheduler().tick({ plan: true });
    expect((await q(`SELECT status FROM app.debts WHERE id = $1`, [IMRAN_DEBT]))[0]).toEqual({ status: 'in_follow_up' });
    expect((await tasksOf(IMRAN_DEBT)).at(-1)).toMatchObject({ status: 'skipped', skip_reason: 'debtor_replied' });
    expect((await notesFor(IMRAN_DEBT)).map((n) => n.title)).toEqual([
      'Imran Khan Demo replied after the last reminder for DBT-2026-0001: decide whether to send it to legal',
    ]);
    expect((await planTasks({ pool, workerPool: worker, now: () => clock })).legal).toBe(0);
  });
});

describe('daily summary (2.5)', () => {
  it('one summary per working day, from 08:00 client time', async () => {
    clock = riyadh('2026-12-06', '07:30');
    expect((await makeScheduler().tick({ plan: false })).summaries).toBe(0);
    clock = riyadh('2026-12-06', '08:05');
    expect((await makeScheduler().tick({ plan: false })).summaries).toBe(1);
    expect((await makeScheduler().tick({ plan: false })).summaries).toBe(0);
    clock = riyadh('2026-12-04', '09:00'); // Friday: none
    await q(`DELETE FROM app.notifications`);
    expect((await makeScheduler().tick({ plan: false })).summaries).toBe(0);

    clock = riyadh('2026-12-06', '08:05');
    await makeScheduler().tick({ plan: false });
    const summary = (await notifications(true)).find((n) => n.target_table === 'daily_summary')!;
    expect(summary.kind).toBe('system');
    expect(summary.title).toMatch(/^Daily summary for 2026-12-06: .*1 payment to review, 3 reminders waiting for your approval$/);
  });
});

describe('staff approval and task routes', () => {
  async function app() {
    const a = buildApp(config, pool, { whatsapp: sender, now: () => clock });
    await a.ready();
    apps.push(a);
    return a;
  }
  const staff = { 'x-client-id': CLIENT, 'x-user-id': STAFF };

  it('with auto send off, reminders wait until staff approve them', async () => {
    const a = await app();
    expect((await makeScheduler().tick({ plan: false })).ran.filter((r) => r.type === 'send_reminder')).toEqual([]);

    const waiting = await a.inject({ url: '/api/reminders/waiting', headers: staff });
    expect(waiting.json().reminders.map((r: { ref_code: string }) => r.ref_code)).toEqual([
      'DBT-2026-0001',
      'DBT-2026-0003',
      'DBT-2026-0005',
    ]);
    const suresh = waiting.json().reminders.find((r: { ref_code: string }) => r.ref_code === 'DBT-2026-0005');
    expect(suresh.amount_outstanding).toBe('1000.00');

    const approve = await a.inject({ method: 'POST', url: '/api/reminders/approve', headers: staff, payload: { task_ids: [suresh.task_id] } });
    expect(approve.json()).toMatchObject({ approved: 1 });
    const result = await makeScheduler().tick({ plan: false });
    expect(result.ran.filter((r) => r.type === 'send_reminder')).toHaveLength(1);
    expect(sender.templates).toHaveLength(1);

    const all = await a.inject({ method: 'POST', url: '/api/reminders/approve', headers: staff, payload: { all: true } });
    expect(all.json()).toMatchObject({ approved: 2 });
  });

  it('viewers cannot approve, and another client cannot see or approve these tasks', async () => {
    await q(
      `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
       VALUES ($1, 'Other Scheduler Client', '0000000077', 'Other', '+966500000277', 'o@test.example', 'active')`,
      [OTHER_CLIENT],
    );
    await q(`INSERT INTO app.users (id, client_id, full_name, email, role) VALUES ($1, $2, 'Other', 'o@test.example', 'owner')`, [
      OTHER_USER,
      OTHER_CLIENT,
    ]);
    await q(
      `INSERT INTO app.users (id, client_id, full_name, email, role) VALUES ('22222222-2222-4222-8222-0000000000ee', $1, 'Viewer', 'v@demo.example', 'viewer')`,
      [CLIENT],
    );
    const a = await app();
    const task = (await tasksOf(SURESH_DEBT))[0]!;
    const other = { 'x-client-id': OTHER_CLIENT, 'x-user-id': OTHER_USER };

    const viewer = await a.inject({
      method: 'POST', url: '/api/reminders/approve', payload: { all: true },
      headers: { 'x-client-id': CLIENT, 'x-user-id': '22222222-2222-4222-8222-0000000000ee' },
    });
    expect(viewer.statusCode).toBe(403);
    const cross = await a.inject({ method: 'POST', url: '/api/reminders/approve', headers: other, payload: { task_ids: [task.id] } });
    expect(cross.json()).toMatchObject({ approved: 0 });
    expect((await a.inject({ url: `/api/debts/${SURESH_DEBT}/tasks`, headers: other })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: `/api/tasks/${task.id}/cancel`, headers: other, payload: { reason: 'not mine' } })).statusCode).toBe(404);
    expect((await a.inject({ url: '/api/reminders/waiting', headers: other })).json().reminders).toEqual([]);
    expect((await tasksOf(SURESH_DEBT))[0]!.status).toBe('pending');
  });

  it('staff can see the plan for a debt and cancel a planned reminder', async () => {
    const a = await app();
    const list = await a.inject({ url: `/api/debts/${SURESH_DEBT}/tasks`, headers: staff });
    expect(list.json().tasks).toMatchObject([{ task_type: 'send_reminder', status: 'pending' }]);
    const id = list.json().tasks[0].id;
    const cancel = await a.inject({ method: 'POST', url: `/api/tasks/${id}/cancel`, headers: staff, payload: { reason: 'Talked to him by phone' } });
    expect(cancel.json()).toEqual({ id, status: 'cancelled' });
    expect((await tasksOf(SURESH_DEBT))[0]!.skip_reason).toBe('cancelled_by_staff: Talked to him by phone');
    expect((await a.inject({ method: 'POST', url: '/api/reminders/approve', headers: staff, payload: { task_ids: ['nope'] } })).statusCode).toBe(400);
  });
});
