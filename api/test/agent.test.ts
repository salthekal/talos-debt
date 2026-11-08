/**
 * The WhatsApp agent: reply checks, the AI client, and full conversations
 * through the Meta webhook with a fake AI and a fake WhatsApp sender.
 */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeminiClient, type LlmClient, type LlmRequest, type LlmResponse } from '../src/ai/llm.js';
import { buildApp } from '../src/app.js';
import { canonicalAmount, checkReply, normalizeDigits, parseDecision } from '../src/agent/decision.js';
import { loadConfig } from '../src/config.js';
import { assertRlsEnforced, assertWorkerRole, createPool } from '../src/db.js';
import type { SendResult, TextMessage, WhatsAppSender } from '../src/whatsapp/client.js';

const API_URL = process.env.TEST_DATABASE_URL ?? 'postgres://talos_api:talos_api_dev@localhost:5432/talos_test';
const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/talos_test';
const WORKER_URL =
  process.env.TEST_WORKER_DATABASE_URL ?? 'postgres://talos_jobs:talos_jobs_dev@localhost:5432/talos_test';

const SECRET = 'test-app-secret';
const MY_PHONE = '+966511111111';
const SUNDAY_10AM = new Date('2026-11-08T07:00:00Z'); // Riyadh 10:00, working hours
const SUNDAY_930PM = new Date('2026-11-08T18:30:00Z'); // Riyadh 21:30, after hours

// Seed data
const FAHAD_PHONE = '+966500000002';
const FAHAD_DEBT = '66666666-6666-4666-8666-000000000002';
const SURESH_PHONE = '+966500000005';
const SURESH_DEBT = '66666666-6666-4666-8666-000000000005';
const IMRAN_PHONE = '+966500000001';
const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001';
const RAHIM_PHONE = '+966500000003';

class FakeLlm implements LlmClient {
  calls: LlmRequest[] = [];
  next: Record<string, unknown> | Error = {};
  async generateJson(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    if (this.next instanceof Error) throw this.next;
    return { text: JSON.stringify(this.next), model: 'fake-model', inputTokens: 100, outputTokens: 20, costUsd: '0' };
  }
}

class FakeSender implements WhatsAppSender {
  texts: TextMessage[] = [];
  async sendTemplate(): Promise<SendResult> {
    return { ok: true, providerMessageId: 'wamid.T' };
  }
  async sendText(msg: TextMessage): Promise<SendResult> {
    this.texts.push(msg);
    return { ok: true, providerMessageId: `wamid.reply.${this.texts.length}.${Date.now()}` };
  }
}

let admin: pg.Pool;
let pool: pg.Pool;
let worker: pg.Pool;
const apps: FastifyInstance[] = [];
let seq = 0;

async function makeApp(llm: LlmClient, sender: FakeSender, now = SUNDAY_10AM) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: API_URL,
    AUTH_MODE: 'dev',
    WHATSAPP_DEV_REDIRECT_TO: MY_PHONE,
    WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    WHATSAPP_APP_SECRET: SECRET,
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
  });
  const app = buildApp(config, pool, { whatsapp: sender, llm, now: () => now, workerPool: worker, processWebhooksInline: true });
  await app.ready();
  apps.push(app);
  return app;
}

function messagePayload(from: string, text: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: `wamid.in.${seq}.${Date.now()}`,
                  from: from.replace('+', ''),
                  timestamp: String(Math.floor(SUNDAY_10AM.getTime() / 1000)),
                  type: 'text',
                  text: { body: text },
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function post(app: FastifyInstance, payload: unknown, secret = SECRET) {
  const body = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    payload: body,
  });
}

const decision = (d: Record<string, unknown>) => ({
  intent: 'question',
  reply: 'Thank you.',
  debt_ref: null,
  promise_date: null,
  promise_amount: null,
  dispute_reason: null,
  needs_human: false,
  confidence: 0.9,
  ...d,
});

async function lastRun(debtorPhone: string) {
  const { rows } = await admin.query(
    `SELECT ar.output, ar.needs_human, ar.model, ar.input_tokens
       FROM ai.agent_runs ar JOIN app.messages m ON m.id = ar.message_id
       JOIN app.debtor_phones p ON p.id = m.phone_id
      WHERE p.phone_e164 = $1 ORDER BY ar.id DESC LIMIT 1`,
    [debtorPhone],
  );
  return rows[0];
}

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  pool = createPool(API_URL);
  worker = createPool(WORKER_URL);
  await admin.query(`UPDATE app.message_templates SET approval_status = 'approved' WHERE client_id IS NULL`);
});

beforeEach(async () => {
  // Each conversation test starts with the debtor's phones active.
  await admin.query(`UPDATE app.debtor_phones SET status = 'active' WHERE phone_e164 = ANY($1)`, [
    [FAHAD_PHONE, SURESH_PHONE, IMRAN_PHONE, RAHIM_PHONE],
  ]);
});

afterAll(async () => {
  for (const app of apps) await app.close();
  await pool?.end();
  await worker?.end();
  await admin?.end();
});

// ---------------------------------------------------------------------------

describe('reply checks', () => {
  const facts = { allowedAmounts: ['3450.00', '1000.00'], allowedRefs: ['DBT-2026-0001'], debtorText: 'I can pay 500 now' };

  it('accepts amounts from the database in any common format', () => {
    expect(checkReply('You owe SAR 3450.00 for DBT-2026-0001.', facts)).toEqual({ ok: true });
    expect(checkReply('المبلغ المتبقي ٣٤٥٠ ريال', facts)).toEqual({ ok: true });
    expect(checkReply('Remaining: 3,450 SAR', facts)).toEqual({ ok: true });
    expect(checkReply('Thank you, we noted your payment of 500.', facts)).toEqual({ ok: true });
  });

  it('rejects an amount the AI made up', () => {
    expect(checkReply('Please pay SAR 3500 today.', facts)).toEqual({ ok: false, reason: 'unknown_amount:3500' });
    expect(checkReply('A late fee of 150.00 applies.', facts).ok).toBe(false);
  });

  it('ignores dates, times and small numbers', () => {
    expect(checkReply('See you on 2026-11-12 at 10:00, in 2 days.', facts)).toEqual({ ok: true });
  });

  it('rejects threats and mentions of family or police', () => {
    expect(checkReply('We will call the police.', facts)).toEqual({ ok: false, reason: 'banned_wording' });
    expect(checkReply('سنتواصل مع عائلتك', facts).ok).toBe(false);
    expect(checkReply('قد تتعرض للسجن', facts).ok).toBe(false);
  });

  it('normalises digits and amounts as text', () => {
    expect(normalizeDigits('١٢٣٫٤')).toBe('123٫4');
    expect(canonicalAmount('3450.00')).toBe('3450');
    expect(canonicalAmount('1280.50')).toBe('1280.5');
  });

  it('parses the AI answer, with or without code fences', () => {
    expect(parseDecision('```json\n{"intent":"greeting","reply":"Hi"}\n```')?.intent).toBe('greeting');
    expect(parseDecision('not json')).toBeUndefined();
    expect(parseDecision('{"intent":"unknown","reply":"x"}')).toBeUndefined();
  });
});

describe('configuration', () => {
  it('refuses the free AI tier in production', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: API_URL, AUTH_MODE: 'dev', AI_PROVIDER: 'gemini', AI_API_KEY: 'k' }),
    ).toThrow();
    expect(() =>
      loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_FREE_TIER: 'true' }),
    ).not.toThrow();
  });

  it('requires a key when a provider is set', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, AI_PROVIDER: 'gemini' })).toThrow(/AI_API_KEY/);
  });

  it('the worker connection is a talos_worker member', async () => {
    await expect(assertWorkerRole(worker)).resolves.toBeUndefined();
    await expect(assertWorkerRole(pool)).rejects.toThrow();
  });

  it('the worker sees every client through policies, without BYPASSRLS', async () => {
    const role = await worker.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0].rolbypassrls).toBe(false);
    const all = await admin.query(`SELECT count(*)::int AS n FROM app.debtors`);
    const seen = await worker.query(`SELECT count(*)::int AS n FROM app.debtors`);
    expect(seen.rows[0].n).toBe(all.rows[0].n);
  });

  it('the API refuses an account that is also in the worker group', async () => {
    await admin.query(`DROP ROLE IF EXISTS talos_test_both`);
    await admin.query(`CREATE ROLE talos_test_both LOGIN PASSWORD 'both_dev' IN ROLE talos_app, talos_worker`);
    const url = new URL(API_URL);
    url.username = 'talos_test_both';
    url.password = 'both_dev';
    const both = createPool(url.toString());
    try {
      await expect(assertRlsEnforced(both)).rejects.toThrow(/not of talos_worker/);
      await expect(assertRlsEnforced(pool)).resolves.toBeUndefined();
    } finally {
      await both.end();
      await admin.query(`DROP ROLE talos_test_both`);
    }
  });
});

describe('Gemini client', () => {
  it('sends the prompt as Gemini expects and reads the answer', async () => {
    let call: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      call = { url, init };
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"intent":"greeting","reply":"Hi"}' }] } }],
          usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 12 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await new GeminiClient('KEY', 'gemini-2.5-flash', true, fakeFetch).generateJson({ system: 'S', user: 'U' });
    expect(call!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect((call!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('KEY');
    const body = JSON.parse(call!.init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('S');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(res).toEqual({ text: '{"intent":"greeting","reply":"Hi"}', model: 'gemini-2.5-flash', inputTokens: 321, outputTokens: 12, costUsd: '0' });
  });
});

// ---------------------------------------------------------------------------

describe('webhook security', () => {
  it('answers the Meta setup check only with the right token', async () => {
    const app = await makeApp(new FakeLlm(), new FakeSender());
    const ok = await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await app.inject({ url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects requests not signed by Meta, and stores nothing', async () => {
    const app = await makeApp(new FakeLlm(), new FakeSender());
    const payload = messagePayload(SURESH_PHONE, 'hello');
    const res = await post(app, payload, 'wrong-secret');
    expect(res.statusCode).toBe(401);
    const id = (payload.entry[0]!.changes[0]!.value.messages[0] as { id: string }).id;
    const { rows } = await admin.query(`SELECT 1 FROM app.webhook_events WHERE event_id = $1`, [`msg:${id}`]);
    expect(rows).toHaveLength(0);
  });
});

describe('conversations', () => {
  it('answers a question with facts from the database', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'You still owe SAR 1000.00 for DBT-2026-0005.', debt_ref: 'DBT-2026-0005' });
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);

    const res = await post(app, messagePayload(SURESH_PHONE, 'How much do I still owe?'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 1 });

    // The AI was given the real figures.
    expect(llm.calls[0]!.user).toContain('"amount_still_owed": "1000.00"');
    expect(llm.calls[0]!.user).toContain('How much do I still owe?');
    expect(llm.calls[0]!.system).toContain('Write the reply in English');

    // Reply went to the development number, never to the fake debtor.
    expect(sender.texts).toEqual([{ phoneNumberId: '1234567890', to: MY_PHONE, text: 'You still owe SAR 1000.00 for DBT-2026-0005.' }]);

    const { rows } = await admin.query(
      `SELECT direction, status, ai_generated, debt_id FROM app.messages
        WHERE debtor_id = '33333333-3333-4333-8333-000000000005' ORDER BY created_at DESC, direction LIMIT 2`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { direction: 'inbound', status: 'received', ai_generated: false, debt_id: SURESH_DEBT },
        { direction: 'outbound', status: 'sent', ai_generated: true, debt_id: SURESH_DEBT },
      ]),
    );
    const run = await lastRun(SURESH_PHONE);
    expect(run).toMatchObject({ needs_human: false, model: 'fake-model', input_tokens: 100 });
    // The phone remembers when the debtor last wrote (opens the 24-hour window).
    const phone = await admin.query(`SELECT last_inbound_at FROM app.debtor_phones WHERE phone_e164 = $1 AND client_id = $2`, [
      SURESH_PHONE,
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(new Date(phone.rows[0].last_inbound_at).toISOString()).toBe(SUNDAY_10AM.toISOString());
  });

  it('ignores the same message sent twice by Meta', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'Thank you.' });
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);
    const payload = messagePayload(SURESH_PHONE, 'Thanks');
    await post(app, payload);
    const again = await post(app, payload);
    expect(again.json()).toEqual({ received: 0 });
    expect(llm.calls).toHaveLength(1);
    expect(sender.texts).toHaveLength(1);
  });

  it('records a promise to pay and schedules a check', async () => {
    const llm = new FakeLlm();
    llm.next = decision({
      intent: 'promise_to_pay',
      reply: 'شكراً، سجلنا وعدك بالسداد يوم الخميس 2026-11-12.',
      debt_ref: 'DBT-2026-0002',
      promise_date: '2026-11-12',
    });
    const app = await makeApp(llm, new FakeSender());
    await admin.query(`UPDATE app.debts SET status = 'in_follow_up' WHERE id = $1`, [FAHAD_DEBT]);

    await post(app, messagePayload(FAHAD_PHONE, 'بسدد يوم الخميس'));

    const promise = await admin.query(
      `SELECT promised_date::text, promised_amount, status FROM app.promises WHERE debt_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [FAHAD_DEBT],
    );
    expect(promise.rows[0]).toEqual({ promised_date: '2026-11-12', promised_amount: null, status: 'pending' });
    const debt = await admin.query(`SELECT status FROM app.debts WHERE id = $1`, [FAHAD_DEBT]);
    expect(debt.rows[0].status).toBe('promised');
    // Grace of 1 day, checked at 10:00 Riyadh time = 07:00 UTC.
    const task = await admin.query(
      `SELECT due_at FROM app.follow_up_tasks WHERE debt_id = $1 AND task_type = 'promise_check' ORDER BY created_at DESC LIMIT 1`,
      [FAHAD_DEBT],
    );
    expect(new Date(task.rows[0].due_at).toISOString()).toBe('2026-11-13T07:00:00.000Z');
  });

  it('ignores a promise date in the past or too far away', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ intent: 'promise_to_pay', reply: 'Thank you.', debt_ref: 'DBT-2026-0002', promise_date: '2027-06-01' });
    const app = await makeApp(llm, new FakeSender());
    const before = await admin.query(`SELECT count(*)::int AS n FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]);
    await post(app, messagePayload(FAHAD_PHONE, 'I will pay next summer'));
    const after = await admin.query(`SELECT count(*)::int AS n FROM app.promises WHERE debt_id = $1`, [FAHAD_DEBT]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect((await lastRun(FAHAD_PHONE)).needs_human).toBe(true);
  });

  it('a dispute stops reminders and alerts the team', async () => {
    const llm = new FakeLlm();
    llm.next = decision({
      intent: 'dispute',
      reply: 'Thank you, our team will review the amount.',
      debt_ref: 'DBT-2026-0001',
      dispute_reason: 'Says he returned the motorcycle in August',
    });
    const app = await makeApp(llm, new FakeSender());
    await admin.query(
      `INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, due_at)
       VALUES ('11111111-1111-4111-8111-111111111111', $1, 'send_reminder', now() + interval '1 day')`,
      [IMRAN_DEBT],
    );

    await post(app, messagePayload(IMRAN_PHONE, 'I returned the bike in August, this is wrong'));

    const debt = await admin.query(`SELECT status FROM app.debts WHERE id = $1`, [IMRAN_DEBT]);
    expect(debt.rows[0].status).toBe('disputed');
    const dispute = await admin.query(`SELECT reason FROM app.disputes WHERE debt_id = $1 AND status = 'open'`, [IMRAN_DEBT]);
    expect(dispute.rows[0].reason).toBe('Says he returned the motorcycle in August');
    const pending = await admin.query(
      `SELECT count(*)::int AS n FROM app.follow_up_tasks WHERE debt_id = $1 AND status = 'pending' AND task_type = 'send_reminder'`,
      [IMRAN_DEBT],
    );
    expect(pending.rows[0].n).toBe(0);
    const note = await admin.query(`SELECT kind FROM app.notifications ORDER BY created_at DESC LIMIT 1`);
    expect(note.rows[0].kind).toBe('dispute');
  });

  it('replaces a reply with a made-up amount by a safe reply', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'Please pay SAR 9999 today to avoid extra fees.' });
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);
    await post(app, messagePayload(SURESH_PHONE, 'What do I owe?'));
    expect(sender.texts[0]!.text).toBe('Thank you for your message. A member of our team will contact you soon.');
    const run = await lastRun(SURESH_PHONE);
    expect(run.needs_human).toBe(true);
    expect(run.output.problem).toBe('reply_rejected:unknown_amount:9999');
  });

  it('replaces a threatening reply by a safe reply', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'If you do not pay we will contact your employer.' });
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);
    await post(app, messagePayload(SURESH_PHONE, 'I cannot pay'));
    expect(sender.texts[0]!.text).toMatch(/A member of our team/);
    expect((await lastRun(SURESH_PHONE)).output.problem).toBe('reply_rejected:banned_wording');
  });

  it('still answers safely when the AI fails', async () => {
    const llm = new FakeLlm();
    llm.next = new Error('quota exceeded');
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);
    await post(app, messagePayload(FAHAD_PHONE, 'السلام عليكم'));
    expect(sender.texts[0]!.text).toBe('شكراً لتواصلك. سيتواصل معك أحد أعضاء الفريق قريباً.');
    const run = await lastRun(FAHAD_PHONE);
    expect(run.needs_human).toBe(true);
    expect(run.output.problem).toMatch(/^ai_error/);
  });

  it('holds the reply for staff outside working hours', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'Thank you.' });
    const sender = new FakeSender();
    const app = await makeApp(llm, sender, SUNDAY_930PM);
    await post(app, messagePayload(SURESH_PHONE, 'Hello?'));
    expect(sender.texts).toHaveLength(0);
    const note = await admin.query(`SELECT title FROM app.notifications ORDER BY created_at DESC LIMIT 1`);
    expect(note.rows[0].title).toMatch(/outside working hours/);
    expect((await lastRun(SURESH_PHONE)).output.sent_now).toBe(false);
  });

  it('a receipt image goes to the team for review', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ intent: 'payment_claimed', reply: 'Thank you, our team will check the receipt.', needs_human: true });
    const app = await makeApp(llm, new FakeSender());
    await post(
      app,
      messagePayload(RAHIM_PHONE, '', { type: 'image', text: undefined, image: { id: 'media1', caption: 'transfer receipt' } }),
    );
    expect(llm.calls[0]!.user).toContain('possibly a payment receipt');
    const note = await admin.query(`SELECT kind FROM app.notifications ORDER BY created_at DESC LIMIT 1`);
    expect(note.rows[0].kind).toBe('payment_to_review');
  });

  it('marks the number when the person says it is the wrong person', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ intent: 'wrong_person', reply: 'Sorry for the trouble.', needs_human: true });
    const app = await makeApp(llm, new FakeSender());
    await post(app, messagePayload(SURESH_PHONE, 'I am not Suresh, wrong number'));
    const phone = await admin.query(`SELECT status FROM app.debtor_phones WHERE phone_e164 = $1`, [SURESH_PHONE]);
    expect(phone.rows[0].status).toBe('wrong_number');
  });

  it('does not answer numbers that are not debtors', async () => {
    const llm = new FakeLlm();
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);
    const payload = messagePayload('+966599999999', 'Who is this?');
    await post(app, payload);
    expect(llm.calls).toHaveLength(0);
    expect(sender.texts).toHaveLength(0);
    const id = (payload.entry[0]!.changes[0]!.value.messages[0] as { id: string }).id;
    const ev = await admin.query(`SELECT processed_at IS NOT NULL AS done, error FROM app.webhook_events WHERE event_id = $1`, [`msg:${id}`]);
    expect(ev.rows[0]).toEqual({ done: true, error: 'unknown_sender' });
  });

  it('in development, replies from your own phone belong to the last debtor messaged', async () => {
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'Thank you.' });
    const sender = new FakeSender();
    const app = await makeApp(llm, sender);
    const last = await admin.query(
      `SELECT debtor_id FROM app.messages WHERE direction = 'outbound' AND phone_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    );
    const payload = messagePayload(MY_PHONE, 'Testing from my own phone');
    await post(app, payload);
    const id = (payload.entry[0]!.changes[0]!.value.messages[0] as { id: string }).id;
    const inbound = await admin.query(`SELECT debtor_id FROM app.messages WHERE provider_message_id = $1`, [id]);
    expect(inbound.rows[0].debtor_id).toBe(last.rows[0].debtor_id);
    expect(sender.texts).toHaveLength(1);
  });
});

describe('delivery updates', () => {
  it('moves the status forward and never back', async () => {
    const app = await makeApp(new FakeLlm(), new FakeSender());
    await admin.query(
      `UPDATE app.messages SET status = 'sent', provider_message_id = 'wamid.status.test' WHERE id = '88888888-8888-4888-8888-000000000002'`,
    );
    const status = (s: string, ts: number) => ({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.status.test', status: s, timestamp: String(ts) }] } }] }],
    });
    await post(app, status('read', 1762585200));
    await post(app, status('delivered', 1762585100)); // arrives late
    const { rows } = await admin.query(
      `SELECT status, delivered_at IS NOT NULL AS delivered, read_at IS NOT NULL AS read FROM app.messages WHERE provider_message_id = 'wamid.status.test'`,
    );
    expect(rows[0]).toEqual({ status: 'read', delivered: true, read: true });
  });
});

describe('a phone shared by two clients', () => {
  it('goes to the client that messaged it most recently', async () => {
    const other = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    await admin.query(
      `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
       VALUES ($1, 'Shared Phone Client', '0000000097', 'Owner', '+966500000297', 'shared@test.example', 'active')`,
      [other],
    );
    const debtor = await admin.query<{ id: string }>(
      `INSERT INTO app.debtors (client_id, ref_code, id_type, id_number, full_name)
       VALUES ($1, 'D-SHARED-1', 'iqama', '2777777777', 'Same Person Other Client') RETURNING id`,
      [other],
    );
    const phone = await admin.query<{ id: string }>(
      `INSERT INTO app.debtor_phones (client_id, debtor_id, phone_e164, is_primary) VALUES ($1, $2, $3, true) RETURNING id`,
      [other, debtor.rows[0]!.id, SURESH_PHONE],
    );
    await admin.query(
      `INSERT INTO app.messages (client_id, debtor_id, phone_id, channel, direction, body, status, created_at)
       VALUES ($1, $2, $3, 'whatsapp', 'outbound', 'Reminder from the other client', 'sent',
               greatest(now(), $4::timestamptz) + interval '1 hour')`,
      // Later than every message the earlier tests saved, whatever today's date is.
      [other, debtor.rows[0]!.id, phone.rows[0]!.id, new Date(SUNDAY_10AM.getTime() + 3600_000)],
    );
    const llm = new FakeLlm();
    llm.next = decision({ reply: 'Thank you.' });
    const app = await makeApp(llm, new FakeSender());
    const payload = messagePayload(SURESH_PHONE, 'Which company is this?');
    await post(app, payload);
    const id = (payload.entry[0]!.changes[0]!.value.messages[0] as { id: string }).id;
    const inbound = await admin.query(`SELECT client_id FROM app.messages WHERE provider_message_id = $1`, [id]);
    expect(inbound.rows[0].client_id).toBe(other);
    // The other client has no open debts, so the AI is not asked and the team is alerted.
    expect(llm.calls).toHaveLength(0);
  });
});
