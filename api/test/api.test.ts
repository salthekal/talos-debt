/**
 * API tests against a freshly reset test database (see "npm test").
 * They cover what CLAUDE.md requires tests for: tenant isolation, money
 * and the payment review rules.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { assertRlsEnforced, createPool } from '../src/db.js';

const API_URL = process.env.TEST_DATABASE_URL ?? 'postgres://talos_api:talos_api_dev@localhost:5432/talos_test';
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/talos_test';

// Seed ids (dev/seed.sql)
const CLIENT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-000000000002';
const RAHIM_DEBTOR = '33333333-3333-4333-8333-000000000003';
const RAHIM_DEBT = '66666666-6666-4666-8666-000000000003';

// Created by these tests
const OTHER_CLIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const VIEWER = '22222222-2222-4222-8222-0000000000ff';

let app: FastifyInstance;
let pool: pg.Pool;
let admin: pg.Pool;

const as = (clientId: string, userId: string) => ({ 'x-client-id': clientId, 'x-user-id': userId });
const staff = as(CLIENT, STAFF);

async function pendingPaymentId(): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `SELECT id FROM app.payments WHERE debt_id = $1 AND status = 'pending_approval'`,
    [RAHIM_DEBT],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(
    `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
     VALUES ($1, 'Other Test Client', '0000000099', 'Other', '+966500000299', 'other@test.example', 'active')
     ON CONFLICT DO NOTHING`,
    [OTHER_CLIENT],
  );
  await admin.query(
    `INSERT INTO app.users (id, client_id, full_name, email, role)
     VALUES ($1, $2, 'Other Owner', 'other@test.example', 'owner'),
            ($3, $4, 'Read Only Viewer', 'viewer@demo.example', 'viewer')
     ON CONFLICT DO NOTHING`,
    [OTHER_USER, OTHER_CLIENT, VIEWER, CLIENT],
  );

  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, AUTH_MODE: 'dev' });
  pool = createPool(config.DATABASE_URL);
  app = buildApp(config, pool);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await admin?.end();
});

describe('safety of the database connection', () => {
  it('the API role enforces Row Level Security', async () => {
    await expect(assertRlsEnforced(pool)).resolves.toBeUndefined();
  });

  it('refuses to start with a superuser connection', async () => {
    await expect(assertRlsEnforced(admin)).rejects.toThrow(/must be a member of talos_app/);
  });

  it('refuses dev login in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: API_URL, AUTH_MODE: 'dev' })).toThrow(
      /not allowed in production/,
    );
  });
});

describe('health and login', () => {
  it('health check works without login', async () => {
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('rejects requests without login headers', async () => {
    const res = await app.inject({ url: '/api/me' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a user claiming another client', async () => {
    const res = await app.inject({ url: '/api/me', headers: as(OTHER_CLIENT, STAFF) });
    expect(res.statusCode).toBe(401);
  });

  it('returns the logged-in user and client', async () => {
    const res = await app.inject({ url: '/api/me', headers: staff });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.role).toBe('staff');
    expect(res.json().client.id).toBe(CLIENT);
  });
});

describe('dashboard reads', () => {
  it('totals match the seed data', async () => {
    const res = await app.inject({ url: '/api/dashboard/totals', headers: staff });
    expect(res.statusCode).toBe(200);
    const t = res.json();
    expect(t.total_owed).toBe('10830.50');
    expect(t.recovered).toBe('1500.00');
    expect(t.disputed).toBe('1500.00');
    expect(t.in_legal).toBe('0.00');
    expect(t.paper_notes_at_risk).toBe('1');
  });

  it('lists debts with filters', async () => {
    const all = await app.inject({ url: '/api/debts', headers: staff });
    expect(all.json().total).toBe(5);
    const disputed = await app.inject({ url: '/api/debts?status=disputed', headers: staff });
    expect(disputed.json().items.map((d: { ref_code: string }) => d.ref_code)).toEqual(['DBT-2026-0004']);
    const search = await app.inject({ url: '/api/debts?search=rahim', headers: staff });
    expect(search.json().total).toBe(1);
  });

  it('rejects an invalid filter', async () => {
    const res = await app.inject({ url: '/api/debts?status=nonsense', headers: staff });
    expect(res.statusCode).toBe(400);
  });

  it('returns a debtor with phones, debts and timeline', async () => {
    const res = await app.inject({ url: `/api/debtors/${RAHIM_DEBTOR}`, headers: staff });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.debtor.ref_code).toBe('D-000003');
    expect(body.phones).toHaveLength(1);
    expect(body.debts).toHaveLength(1);
    expect(body.timeline.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['message', 'payment']));
    // Money stays text inside the timeline too (jsonb would otherwise turn it into a JSON number).
    const payment = body.timeline.find((e: { kind: string }) => e.kind === 'payment');
    expect(payment.data.amount).toBe('1000.00');
  });

  it('lists pending payments and open disputes', async () => {
    const res = await app.inject({ url: '/api/approvals', headers: staff });
    const body = res.json();
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].debt_ref).toBe('DBT-2026-0003');
    expect(body.disputes).toHaveLength(1);
    expect(body.disputes[0].debt_ref).toBe('DBT-2026-0004');
  });
});

describe('tenant isolation through the API', () => {
  const other = as(OTHER_CLIENT, OTHER_USER);

  it('another client sees none of the demo client data', async () => {
    const debts = await app.inject({ url: '/api/debts', headers: other });
    expect(debts.json().total).toBe(0);
    const approvals = await app.inject({ url: '/api/approvals', headers: other });
    expect(approvals.json()).toEqual({ payments: [], disputes: [] });
  });

  it('another client cannot open a demo debtor', async () => {
    const res = await app.inject({ url: `/api/debtors/${RAHIM_DEBTOR}`, headers: other });
    expect(res.statusCode).toBe(404);
  });

  it('another client cannot approve a demo payment', async () => {
    const id = await pendingPaymentId();
    const res = await app.inject({ method: 'POST', url: `/api/payments/${id}/approve`, headers: other });
    expect(res.statusCode).toBe(404);
    const { rows } = await admin.query(`SELECT status FROM app.payments WHERE id = $1`, [id]);
    expect(rows[0].status).toBe('pending_approval');
  });
});

describe('payment review', () => {
  it('a viewer cannot approve payments', async () => {
    const id = await pendingPaymentId();
    const res = await app.inject({ method: 'POST', url: `/api/payments/${id}/approve`, headers: as(CLIENT, VIEWER) });
    expect(res.statusCode).toBe(403);
  });

  it('rejecting needs a reason', async () => {
    const id = await pendingPaymentId();
    const res = await app.inject({ method: 'POST', url: `/api/payments/${id}/reject`, headers: staff, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('approving a payment reduces the balance and records the reviewer', async () => {
    const id = await pendingPaymentId();
    const res = await app.inject({ method: 'POST', url: `/api/payments/${id}/approve`, headers: staff });
    expect(res.statusCode).toBe(200);
    expect(res.json().debt).toMatchObject({ amount_outstanding: '1100.00', status: 'partly_paid' });

    const { rows } = await admin.query(`SELECT reviewed_by FROM app.payments WHERE id = $1`, [id]);
    expect(rows[0].reviewed_by).toBe(STAFF);

    const log = await admin.query(
      `SELECT actor_type, actor_id FROM audit.activity_log
        WHERE target_table = 'app.payments' AND target_id = $1 AND action = 'payments.update'`,
      [id],
    );
    expect(log.rows[0]).toMatchObject({ actor_type: 'user', actor_id: STAFF });
  });

  it('a payment cannot be approved twice', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT id FROM app.payments WHERE debt_id = $1 AND status = 'approved'`,
      [RAHIM_DEBT],
    );
    const res = await app.inject({ method: 'POST', url: `/api/payments/${rows[0]!.id}/approve`, headers: staff });
    expect(res.statusCode).toBe(404);
  });

  it('rejecting a payment keeps the balance unchanged', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO app.payments (client_id, debt_id, amount, method, status)
       VALUES ($1, $2, 500.00, 'bank_transfer', 'pending_approval') RETURNING id`,
      [CLIENT, RAHIM_DEBT],
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/payments/${rows[0]!.id}/reject`,
      headers: staff,
      payload: { reason: 'Amount on the receipt does not match' },
    });
    expect(res.statusCode).toBe(200);
    const debt = await admin.query(`SELECT amount_outstanding FROM app.debts WHERE id = $1`, [RAHIM_DEBT]);
    expect(debt.rows[0].amount_outstanding).toBe('1100.00');
  });
});

describe('database connections', () => {
  it('an idle connection closed by the server does not stop the process', async () => {
    const pool = createPool(API_URL);
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    client.release();
    const admin = createPool(ADMIN_URL);
    await admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
    await admin.end();
    // Without an error listener this would throw an unhandled 'error' event.
    await new Promise((r) => setTimeout(r, 200));
    const again = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(again.rows[0]!.ok).toBe(1);
    await pool.end();
  });
});
