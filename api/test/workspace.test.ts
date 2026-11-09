/**
 * Phase 4 API: overview numbers, notifications, settings (rules, users),
 * deciding disputes, pausing and resuming, recording a payment by hand.
 * Every action is checked for roles and for isolation between clients.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import type { Mail, Mailer } from '../src/login/mailer.js';
import { RateLimiter } from '../src/login/routes.js';
import { ADMIN_URL, API_URL, CLIENT, OTHER_CLIENT, OTHER_USER, OWNER, STAFF, SURESH_DEBT, VIEWER, as } from './helpers.js';

const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001';
const FAHAD_DEBT = '66666666-6666-4666-8666-000000000002';
const AHMED_DEBT = '66666666-6666-4666-8666-000000000004';

const owner = as(CLIENT, OWNER);
const staffH = as(CLIENT, STAFF);
const viewerH = as(CLIENT, VIEWER);
const otherH = as(OTHER_CLIENT, OTHER_USER);

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
}

let admin: pg.Pool;
let pool: pg.Pool;
let app: FastifyInstance;
const mailer = new FakeMailer();

const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await admin.query<T>(sql, p)).rows;
const call = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as never });

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(
    `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
     VALUES ($1, 'Other Client', '0000000088', 'Other', '+966500000288', 'other@test.example', 'active') ON CONFLICT DO NOTHING`,
    [OTHER_CLIENT],
  );
  await admin.query(
    `INSERT INTO app.users (id, client_id, full_name, email, role) VALUES
       ($1, $2, 'Other Owner', 'other-owner@test.example', 'owner'),
       ($3, $4, 'Read Only', 'viewer@demo.example', 'viewer') ON CONFLICT DO NOTHING`,
    [OTHER_USER, OTHER_CLIENT, VIEWER, CLIENT],
  );
  pool = createPool(API_URL);
  const config = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: API_URL, AUTH_MODE: 'dev',
    STORAGE_LOCAL_DIR: mkdtempSync(path.join(tmpdir(), 'talos-ws-')),
  });
  app = buildApp(config, pool, { mailer, loginLimiter: new RateLimiter(1000, 60_000) });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.end();
});

describe('overview numbers', () => {
  it('counts reminders sent, open promises and legal debts, and amounts by status', async () => {
    const res = await call('GET', '/api/dashboard/summary', staffH);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const seed = (await q<{ s: number }>(`SELECT sum(attempts_count)::int AS s FROM app.debts WHERE client_id = $1`, [CLIENT]))[0]!;
    expect(body.reminders_sent).toBe(seed.s);
    expect(body.promises_open).toBe(1);
    expect(body.statuses.partly_paid).toEqual({ count: 1, outstanding: '1000.00' });
    expect(body.statuses.disputed).toEqual({ count: 1, outstanding: '1500.00' });
    // Another client sees only its own (nothing).
    const other = (await call('GET', '/api/dashboard/summary', otherH)).json();
    expect(other).toMatchObject({ reminders_sent: 0, promises_open: 0, legal: 0, statuses: {} });
  });
});

describe('notifications', () => {
  it('lists them with their details, and marks them read', async () => {
    await q(
      `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data) VALUES
         ($1, 'payment_to_review', 'Rahim sent a receipt', 'app.debts', '66666666-6666-4666-8666-000000000003', '{"event":"receipt","name":"Rahim Uddin Demo","ref":"DBT-2026-0003","amount":"1000.00"}'),
         ($1, 'legal_ready', 'Old row without details', 'app.debts', $2, NULL),
         ($3, 'system', 'Another client only', NULL, NULL, NULL)`,
      [CLIENT, IMRAN_DEBT, OTHER_CLIENT],
    );
    const res = (await call('GET', '/api/notifications', staffH)).json();
    expect(res.unread).toBe(2);
    expect(res.items.map((n: { title: string }) => n.title)).not.toContain('Another client only');
    const receipt = res.items.find((n: { kind: string }) => n.kind === 'payment_to_review');
    expect(receipt.data).toEqual({ event: 'receipt', name: 'Rahim Uddin Demo', ref: 'DBT-2026-0003', amount: '1000.00' });
    // An older row gets its details from the debt.
    const old = res.items.find((n: { kind: string }) => n.kind === 'legal_ready');
    expect(old.data).toMatchObject({ ref: 'DBT-2026-0001' });

    const one = await call('POST', '/api/notifications/read', staffH, { ids: [receipt.id] });
    expect(one.json()).toEqual({ read: 1 });
    expect((await call('GET', '/api/notifications?unread=true', staffH)).json().items).toHaveLength(1);
    // Another client cannot mark these as read.
    expect((await call('POST', '/api/notifications/read', otherH, { ids: [old.id] })).json()).toEqual({ read: 0 });
    expect((await call('POST', '/api/notifications/read', staffH, { all: true })).json()).toEqual({ read: 1 });
    expect((await call('GET', '/api/notifications', staffH)).json().unread).toBe(0);
  });
});

describe('follow-up rules', () => {
  it('everyone reads them; only owners and admins change them', async () => {
    const rules = (await call('GET', '/api/settings/rules', staffH)).json();
    expect(rules).toMatchObject({ interval_days: 2, max_attempts: 5, auto_send: false, timezone: 'Asia/Riyadh' });
    expect(rules.working_hours_start).toBe('09:00');

    expect((await call('PATCH', '/api/settings/rules', staffH, { interval_days: 3 })).statusCode).toBe(403);
    const changed = await call('PATCH', '/api/settings/rules', owner, { interval_days: 3, working_days: [4, 0, 0, 1], auto_send: true });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ interval_days: 3, working_days: [0, 1, 4], auto_send: true, max_attempts: 5 });

    const bad = await call('PATCH', '/api/settings/rules', owner, { working_hours_start: '21:00' });
    expect(bad.statusCode).toBe(400);
    expect((await call('PATCH', '/api/settings/rules', owner, { interval_days: 99 })).statusCode).toBe(400);
    expect((await call('PATCH', '/api/settings/rules', owner, { unknown_field: 1 })).statusCode).toBe(400);
    await call('PATCH', '/api/settings/rules', owner, { interval_days: 2, working_days: [0, 1, 2, 3, 4], auto_send: false });
  });

  it('lists the message templates', async () => {
    const t = (await call('GET', '/api/templates', staffH)).json();
    expect(t.items.length).toBeGreaterThan(0);
    expect(t.items[0]).toHaveProperty('purpose');
  });
});

describe('users and roles', () => {
  it('an owner adds a user, who gets an invitation email', async () => {
    mailer.sent = [];
    const res = await call('POST', '/api/users', owner, { full_name: 'Sara Collections', email: 'Sara@Demo.example', role: 'staff' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: 'sara@demo.example', role: 'staff', is_active: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toContain('invitation');
    expect(mailer.sent[0]!.text).toContain('Al Nokhba');

    expect((await call('POST', '/api/users', owner, { full_name: 'Copy', email: 'sara@demo.example', role: 'staff' })).statusCode).toBe(409);
    expect((await call('POST', '/api/users', staffH, { full_name: 'X', email: 'x@demo.example', role: 'staff' })).statusCode).toBe(403);
  });

  it('roles are changed safely: not your own, not by non-owners for owners, never the last owner', async () => {
    const users = (await call('GET', '/api/users', staffH)).json().items as { id: string; email: string }[];
    const sara = users.find((u) => u.email === 'sara@demo.example')!;

    expect((await call('PATCH', `/api/users/${OWNER}`, owner, { role: 'staff' })).statusCode).toBe(400);
    expect((await call('PATCH', `/api/users/${sara.id}`, owner, { role: 'admin' })).json()).toMatchObject({ role: 'admin' });

    // An admin cannot make someone an owner.
    const adminH = as(CLIENT, sara.id);
    expect((await call('PATCH', `/api/users/${STAFF}`, adminH, { role: 'owner' })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/users/${OWNER}`, adminH, { is_active: false })).statusCode).toBe(403);

    // Another client cannot touch these users.
    expect((await call('PATCH', `/api/users/${STAFF}`, otherH, { role: 'viewer' })).statusCode).toBe(404);
  });

  it('deactivating a user ends their sessions', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'staff@demo.example', password: 'talos-dev-password' } });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/users/${STAFF}`, owner, { is_active: false })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    await call('PATCH', `/api/users/${STAFF}`, owner, { is_active: true });
  });
});

describe('deciding a dispute', () => {
  const disputeOf = async (debt: string) =>
    (await q<{ id: string }>(`SELECT id FROM app.disputes WHERE debt_id = $1 AND status = 'open'`, [debt]))[0]!.id;

  it('only reviewers decide, and only for their own client', async () => {
    const id = await disputeOf(AHMED_DEBT);
    expect((await call('POST', `/api/disputes/${id}/resolve`, viewerH, { outcome: 'amount_correct', note: 'Checked' })).statusCode).toBe(403);
    expect((await call('POST', `/api/disputes/${id}/resolve`, otherH, { outcome: 'amount_correct', note: 'Checked' })).statusCode).toBe(404);
  });

  it('"debtor is right" can correct the amount, but never below what was paid', async () => {
    const id = await disputeOf(AHMED_DEBT);
    const below = await call('POST', `/api/disputes/${id}/resolve`, staffH, { outcome: 'debtor_right', action: 'correct_amount', corrected_amount: '0', note: 'Fines were paid' });
    expect(below.statusCode).toBe(400);
    const res = await call('POST', `/api/disputes/${id}/resolve`, staffH, { outcome: 'debtor_right', action: 'correct_amount', corrected_amount: '900.00', note: 'Two fines were paid by him' });
    expect(res.statusCode).toBe(200);
    expect(res.json().debt).toMatchObject({ amount_original: '900.00', amount_outstanding: '900.00' });
    expect(res.json().debt_status).toBe('in_follow_up');
    // The change is in the audit log, by this user.
    const audit = await q(`SELECT 1 FROM audit.activity_log WHERE target_id = $1 AND actor_id = $2 AND action LIKE 'debts.%'`, [AHMED_DEBT, STAFF]);
    expect(audit.length).toBeGreaterThan(0);
    expect((await call('POST', `/api/disputes/${id}/resolve`, staffH, { outcome: 'amount_correct', note: 'again' })).statusCode).toBe(409);
  });

  it('"amount is correct" restarts follow-up; "close" closes the debt', async () => {
    await q(`INSERT INTO app.disputes (client_id, debt_id, reason) VALUES ($1, $2, 'Not mine')`, [CLIENT, SURESH_DEBT]);
    const a = await call('POST', `/api/disputes/${await disputeOf(SURESH_DEBT)}/resolve`, staffH, { outcome: 'amount_correct', note: 'Contract signed' });
    expect(a.json().debt_status).toBe('partly_paid');

    await q(`INSERT INTO app.disputes (client_id, debt_id, reason) VALUES ($1, $2, 'Wrong person')`, [CLIENT, SURESH_DEBT]);
    const b = await call('POST', `/api/disputes/${await disputeOf(SURESH_DEBT)}/resolve`, staffH, { outcome: 'debtor_right', action: 'close', note: 'Charged by mistake' });
    expect(b.json().debt_status).toBe('closed');
  });
});

describe('pausing and resuming', () => {
  it('pausing stops planned reminders and records why', async () => {
    const res = await call('POST', `/api/debts/${IMRAN_DEBT}/pause`, staffH, { reason: 'On sick leave', until: '2026-12-31' });
    expect(res.statusCode).toBe(200);
    expect((await q(`SELECT status, paused_until::text FROM app.debts WHERE id = $1`, [IMRAN_DEBT]))[0]).toEqual({ status: 'paused', paused_until: '2026-12-31' });
    expect(await q(`SELECT 1 FROM app.follow_up_tasks WHERE debt_id = $1 AND status = 'pending'`, [IMRAN_DEBT])).toHaveLength(0);
    const audit = await q<{ details: { reason: string } }>(`SELECT details FROM audit.activity_log WHERE action = 'debt.paused' AND target_id = $1`, [IMRAN_DEBT]);
    expect(audit[0]!.details.reason).toBe('On sick leave');

    expect((await call('POST', `/api/debts/${IMRAN_DEBT}/pause`, staffH, { reason: 'Again' })).statusCode).toBe(409);
    const resumed = await call('POST', `/api/debts/${IMRAN_DEBT}/resume`, staffH);
    expect(resumed.json()).toEqual({ status: 'in_follow_up' });
    expect((await call('POST', `/api/debts/${IMRAN_DEBT}/resume`, staffH)).statusCode).toBe(409);
  });

  it('viewers and other clients cannot pause', async () => {
    expect((await call('POST', `/api/debts/${IMRAN_DEBT}/pause`, viewerH, { reason: 'Not allowed' })).statusCode).toBe(403);
    expect((await call('POST', `/api/debts/${IMRAN_DEBT}/pause`, otherH, { reason: 'Not allowed' })).statusCode).toBe(404);
  });
});

describe('recording a payment by hand', () => {
  it('is approved at once and lowers what is owed; paying all marks the debt paid', async () => {
    const part = await call('POST', `/api/debts/${FAHAD_DEBT}/payments`, staffH, { amount: '280.50', method: 'cash', paid_at: '2026-11-09' });
    expect(part.statusCode).toBe(201);
    expect(part.json().payment).toMatchObject({ amount: '280.50', status: 'approved' });
    expect(part.json().debt).toEqual({ status: 'partly_paid', amount_outstanding: '1000.00' });

    const tooMuch = await call('POST', `/api/debts/${FAHAD_DEBT}/payments`, staffH, { amount: '1000.01', method: 'cash', paid_at: '2026-11-09' });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().message).toContain('1000.00');
    expect((await call('POST', `/api/debts/${FAHAD_DEBT}/payments`, staffH, { amount: '12.345', method: 'cash', paid_at: '2026-11-09' })).statusCode).toBe(400);

    const rest = await call('POST', `/api/debts/${FAHAD_DEBT}/payments`, staffH, { amount: '1000', method: 'bank_transfer', paid_at: '2026-11-09', note: 'Statement line 14' });
    expect(rest.json().debt).toEqual({ status: 'paid', amount_outstanding: '0.00' });
  });

  it('viewers and other clients cannot record payments', async () => {
    expect((await call('POST', `/api/debts/${IMRAN_DEBT}/payments`, viewerH, { amount: '10', method: 'cash', paid_at: '2026-11-09' })).statusCode).toBe(403);
    expect((await call('POST', `/api/debts/${IMRAN_DEBT}/payments`, otherH, { amount: '10', method: 'cash', paid_at: '2026-11-09' })).statusCode).toBe(404);
  });
});
