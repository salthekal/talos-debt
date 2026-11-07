/**
 * Sending reminders on WhatsApp, with Meta replaced by a fake sender.
 * Covers the stop rules, working hours, tenant isolation and what gets saved.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { MetaCloudSender, renderTemplate, type SendResult, type TemplateMessage, type WhatsAppSender } from '../src/whatsapp/client.js';
import { localDayAndTime } from '../src/whatsapp/outbound.js';

const API_URL = process.env.TEST_DATABASE_URL ?? 'postgres://talos_api:talos_api_dev@localhost:5432/talos_test';
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/talos_test';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const STAFF = '22222222-2222-4222-8222-000000000002';
const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001'; // in follow-up, Urdu speaker, one wrong number
const AHMED_DEBT = '66666666-6666-4666-8666-000000000004'; // disputed
const IMRAN_PRIMARY_PHONE = '44444444-4444-4444-8444-000000000001';
const OTHER_CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-000000000001';
const VIEWER = '22222222-2222-4222-8222-0000000000ee';

const MY_PHONE = '+966511111111';
// Sunday 8 Nov 2026, 10:00 in Riyadh (07:00 UTC): inside working hours.
const SUNDAY_10AM = new Date('2026-11-08T07:00:00Z');
// Same Sunday, 21:30 in Riyadh: after hours.
const SUNDAY_930PM = new Date('2026-11-08T18:30:00Z');
// Friday 13 Nov 2026, 10:00 in Riyadh: not a working day.
const FRIDAY_10AM = new Date('2026-11-13T07:00:00Z');

class FakeSender implements WhatsAppSender {
  sent: TemplateMessage[] = [];
  next: SendResult = { ok: true, providerMessageId: 'wamid.FAKE1' };
  async sendTemplate(msg: TemplateMessage): Promise<SendResult> {
    this.sent.push(msg);
    return this.next;
  }
}

let admin: pg.Pool;
let pool: pg.Pool;
const apps: FastifyInstance[] = [];
const staff = { 'x-client-id': CLIENT, 'x-user-id': STAFF };

function configWith(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: API_URL,
    AUTH_MODE: 'dev',
    WHATSAPP_DEV_REDIRECT_TO: MY_PHONE,
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    ...overrides,
  });
}

async function makeApp(opts: { config?: Config; sender?: WhatsAppSender | null; now?: Date } = {}) {
  const app = buildApp(opts.config ?? configWith(), pool, {
    whatsapp: opts.sender === null ? undefined : (opts.sender ?? new FakeSender()),
    now: () => opts.now ?? SUNDAY_10AM,
  });
  await app.ready();
  apps.push(app);
  return app;
}

const send = (app: FastifyInstance, debtId: string, headers = staff, purpose = 'follow_up') =>
  app.inject({ method: 'POST', url: `/api/debts/${debtId}/send-reminder`, headers, payload: { purpose } });

async function messageCount(debtId: string): Promise<number> {
  const { rows } = await admin.query(`SELECT count(*)::int AS n FROM app.messages WHERE debt_id = $1`, [debtId]);
  return rows[0].n;
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  pool = createPool(API_URL);
  await admin.query(
    `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
     VALUES ($1, 'Third Test Client', '0000000098', 'Third', '+966500000298', 'third@test.example', 'active')
     ON CONFLICT DO NOTHING`,
    [OTHER_CLIENT],
  );
  await admin.query(
    `INSERT INTO app.users (id, client_id, full_name, email, role)
     VALUES ($1, $2, 'Third Owner', 'third@test.example', 'owner'),
            ($3, $4, 'Viewer Two', 'viewer2@demo.example', 'viewer')
     ON CONFLICT DO NOTHING`,
    [OTHER_USER, OTHER_CLIENT, VIEWER, CLIENT],
  );
});

beforeEach(async () => {
  // Templates start as drafts; most tests need them approved.
  await admin.query(`UPDATE app.message_templates SET approval_status = 'approved' WHERE client_id IS NULL`);
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await pool?.end();
  await admin?.end();
});

describe('working hours helper', () => {
  it('reads the day and time in Riyadh', () => {
    expect(localDayAndTime(SUNDAY_10AM, 'Asia/Riyadh')).toEqual({ day: 0, time: '10:00' });
    expect(localDayAndTime(FRIDAY_10AM, 'Asia/Riyadh')).toEqual({ day: 5, time: '10:00' });
  });
});

describe('configuration safety', () => {
  it('refuses to send outside production without a redirect number', async () => {
    const cfg = loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, AUTH_MODE: 'dev' });
    const noRedirect = await makeApp({ config: cfg });
    const res = await send(noRedirect, IMRAN_DEBT);
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/WHATSAPP_DEV_REDIRECT_TO/);
  });

  it('reports when WhatsApp is not configured', async () => {
    const app = await makeApp({ sender: null });
    const res = await send(app, IMRAN_DEBT);
    expect(res.statusCode).toBe(503);
  });

  it('does not allow development overrides in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: API_URL, AUTH_MODE: 'dev', WHATSAPP_DEV_REDIRECT_TO: MY_PHONE }),
    ).toThrow();
  });
}, 20_000);

describe('sending a reminder', () => {
  it('sends the template and records the message', async () => {
    const sender = new FakeSender();
    const app = await makeApp({ sender });
    const before = await admin.query(`SELECT attempts_count FROM app.debts WHERE id = $1`, [IMRAN_DEBT]);

    const res = await send(app, IMRAN_DEBT);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: 'sent', to: MY_PHONE, redirected: true, providerMessageId: 'wamid.FAKE1' });

    // Debtor prefers Urdu; there is no Urdu template, so Arabic is used, with values from the database.
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toMatchObject({
      phoneNumberId: '1234567890',
      to: MY_PHONE,
      templateName: 'debt_follow_up',
      languageCode: 'ar',
      bodyParams: ['Imran Khan Demo', 'Al Nokhba Demo Delivery', '3450.00', 'DBT-2026-0001'],
    });

    const msg = await admin.query(
      `SELECT status, provider_message_id, phone_id, sent_by, template_id IS NOT NULL AS has_template, body
         FROM app.messages WHERE id = $1`,
      [body.messageId],
    );
    expect(msg.rows[0]).toMatchObject({
      status: 'sent',
      provider_message_id: 'wamid.FAKE1',
      phone_id: IMRAN_PRIMARY_PHONE, // the wrong number is skipped
      sent_by: STAFF,
      has_template: true,
    });
    expect(msg.rows[0].body).toContain('3450.00');

    const after = await admin.query(`SELECT attempts_count, last_contact_at FROM app.debts WHERE id = $1`, [IMRAN_DEBT]);
    expect(after.rows[0].attempts_count).toBe(before.rows[0].attempts_count + 1);
  });

  it('uses the development template when set', async () => {
    const sender = new FakeSender();
    sender.next = { ok: true, providerMessageId: 'wamid.FAKE2' };
    const app = await makeApp({ sender, config: configWith({ WHATSAPP_DEV_TEMPLATE: 'hello_world:en_US' }) });
    const res = await send(app, IMRAN_DEBT);
    expect(res.statusCode).toBe(200);
    expect(sender.sent[0]).toMatchObject({ templateName: 'hello_world', languageCode: 'en_US', bodyParams: [] });
  });

  it('saves a failed message when Meta rejects it', async () => {
    const sender = new FakeSender();
    sender.next = { ok: false, errorCode: 'meta_132001', errorMessage: 'Template does not exist', retryable: false };
    const app = await makeApp({ sender });
    const before = await admin.query(`SELECT attempts_count FROM app.debts WHERE id = $1`, [IMRAN_DEBT]);

    const res = await send(app, IMRAN_DEBT);
    expect(res.statusCode).toBe(502);
    const msg = await admin.query(`SELECT status, error_code FROM app.messages WHERE id = $1`, [res.json().messageId]);
    expect(msg.rows[0]).toEqual({ status: 'failed', error_code: 'meta_132001' });

    const after = await admin.query(`SELECT attempts_count FROM app.debts WHERE id = $1`, [IMRAN_DEBT]);
    expect(after.rows[0].attempts_count).toBe(before.rows[0].attempts_count);
  });
});

describe('stop rules', () => {
  it('never sends to a disputed debt', async () => {
    const sender = new FakeSender();
    const app = await makeApp({ sender });
    const before = await messageCount(AHMED_DEBT);
    const res = await send(app, AHMED_DEBT);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('debt_not_active');
    expect(sender.sent).toHaveLength(0);
    expect(await messageCount(AHMED_DEBT)).toBe(before);
  });

  it('does not send after working hours or on a day off', async () => {
    for (const now of [SUNDAY_930PM, FRIDAY_10AM]) {
      const sender = new FakeSender();
      const app = await makeApp({ sender, now });
      const before = await messageCount(IMRAN_DEBT);
      const res = await send(app, IMRAN_DEBT);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('outside_working_hours');
      expect(sender.sent).toHaveLength(0);
      expect(await messageCount(IMRAN_DEBT)).toBe(before);
    }
  });

  it('does not send without an approved template', async () => {
    await admin.query(`UPDATE app.message_templates SET approval_status = 'draft' WHERE client_id IS NULL`);
    const sender = new FakeSender();
    const app = await makeApp({ sender });
    const res = await send(app, IMRAN_DEBT);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_template');
    expect(sender.sent).toHaveLength(0);
  });
});

describe('who can send', () => {
  it('a viewer cannot send', async () => {
    const app = await makeApp();
    const res = await send(app, IMRAN_DEBT, { 'x-client-id': CLIENT, 'x-user-id': VIEWER });
    expect(res.statusCode).toBe(403);
  });

  it('another client cannot send to this client\'s debtor', async () => {
    const sender = new FakeSender();
    const app = await makeApp({ sender });
    const res = await send(app, IMRAN_DEBT, { 'x-client-id': OTHER_CLIENT, 'x-user-id': OTHER_USER });
    expect(res.statusCode).toBe(404);
    expect(sender.sent).toHaveLength(0);
  });
});

describe('Meta Cloud API client', () => {
  it('builds the request Meta expects', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.REAL' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new MetaCloudSender('TOKEN123', 'v21.0', fakeFetch);
    const res = await client.sendTemplate({
      phoneNumberId: '999',
      to: '+966511111111',
      templateName: 'debt_follow_up',
      languageCode: 'ar',
      bodyParams: ['Ali', '100.00'],
    });
    expect(res).toEqual({ ok: true, providerMessageId: 'wamid.REAL' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/999/messages');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN123');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '966511111111',
      type: 'template',
      template: {
        name: 'debt_follow_up',
        language: { code: 'ar' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ali' }, { type: 'text', text: '100.00' }] }],
      },
    });
  });

  it('turns Meta errors into a clear result', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }), {
        status: 401,
      })) as unknown as typeof fetch;
    const res = await new MetaCloudSender('BAD', 'v21.0', fakeFetch).sendTemplate({
      phoneNumberId: '999',
      to: '+966511111111',
      templateName: 'hello_world',
      languageCode: 'en_US',
      bodyParams: [],
    });
    expect(res).toEqual({
      ok: false,
      errorCode: 'meta_190',
      errorMessage: 'Invalid OAuth access token',
      retryable: false,
    });
  });

  it('fills template placeholders', () => {
    expect(renderTemplate('Hello {{1}}, SAR {{2}}', ['Ali', '100.00'])).toBe('Hello Ali, SAR 100.00');
  });
});
