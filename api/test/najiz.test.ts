/**
 * Step 5.4: filing on Najiz from Talos. The real robot drives a real
 * Chromium against a fake Najiz (test/fake-najiz.ts) with the same pages and
 * words, so these tests check the whole way: the run the dashboard starts,
 * the Nafath number, every value typed into Najiz, and what is saved after.
 *
 * And the safety rules: only approved notes, one sign-in at a time, nothing
 * sent when Najiz looks different or staff press stop, never a second filing
 * of a note that may already be on Najiz, nothing seen by another client.
 */
import pg from 'pg';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { cityInArabic, najizDate, plain, PlaywrightNajizSite, sharedChromium } from '../src/najiz/robot.js';
import { recoverLostRuns } from '../src/najiz/runs.js';
import { saudiMobile, splitAmount } from '../src/najiz/site.js';
import { NajizWorker } from '../src/najiz/worker.js';
import { startFakeNajiz } from './fake-najiz.js';
import { as, CLIENT, multipart, other, OWNER, staff, startApp, viewer, type TestApp } from './helpers.js';

const WORKER_URL = process.env.TEST_WORKER_DATABASE_URL ?? 'postgres://talos_jobs:talos_jobs_dev@localhost:5432/talos_test';
const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001'; // Nafith note (10,000), owes 3,450
const RAHIM_DEBT = '66666666-6666-4666-8666-000000000003'; // paper note (8,000), owes 2,100
const owner = as(CLIENT, OWNER);

let t: TestApp;
let workerPool: pg.Pool;
let fake: Awaited<ReturnType<typeof startFakeNajiz>>;
const chromium = sharedChromium();

function makeWorker(o: { nafathSeconds?: number; sendTimeoutMs?: number } = {}) {
  return new NajizWorker({
    pool: t.pool, workerPool, storage: t.storage,
    site: () => new PlaywrightNajizSite({ baseUrl: fake.url, browser: chromium.get, stepTimeoutMs: 4000, sendTimeoutMs: o.sendTimeoutMs ?? 4000 }),
    nafathSeconds: o.nafathSeconds ?? 30, staleMinutes: 5, pollMs: 100, now: () => new Date(),
    log: { info: () => undefined, error: (o: object) => process.env.NAJIZ_DEBUG && console.error(o) },
  });
}

async function onePagePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 14 });
  return Buffer.from(await doc.save());
}
async function upload(fields: Record<string, string>, bytes: Buffer, name: string) {
  const body = multipart(fields, { name, bytes });
  const res = await t.app.inject({ method: 'POST', url: '/api/documents', headers: { ...staff, ...body.headers }, payload: body.payload });
  expect(res.statusCode).toBe(201);
}
const send = (method: 'POST' | 'PATCH' | 'GET', url: string, payload?: unknown, headers = staff) =>
  t.app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined });
const start = (debtIds: string[], extra: Record<string, unknown> = {}, headers = staff) =>
  send('POST', '/api/najiz/runs', { debt_ids: debtIds, ...extra }, headers);
const stageOf = async (runId: string) => (await t.admin.query(`SELECT stage FROM app.najiz_runs WHERE id = $1`, [runId])).rows[0]?.stage;
async function until(check: () => Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waited too long');
}
/** Run the worker, approve Nafath as soon as Najiz asks, and wait for the run to end. */
async function runWithNafath(runId: string, worker = makeWorker()) {
  const done = worker.tick();
  await until(async () => (await stageOf(runId)) !== 'starting');
  if ((await stageOf(runId)) === 'waiting_nafath') fake.approve();
  await done;
}

beforeAll(async () => {
  t = await startApp();
  workerPool = createPool(WORKER_URL);
  fake = await startFakeNajiz();
  await t.admin.query(`UPDATE app.debts SET status = 'legal_ready' WHERE id = ANY($1)`, [[IMRAN_DEBT, RAHIM_DEBT]]);
  await upload({ doc_type: 'cr' }, await onePagePdf('CR'), 'cr.pdf');
  await upload({ doc_type: 'promissory_note', debt_id: IMRAN_DEBT }, await onePagePdf('NOTE 1'), 'note-imran.pdf');
  await upload({ doc_type: 'promissory_note', debt_id: RAHIM_DEBT }, await onePagePdf('NOTE 3'), 'note-rahim.pdf');
  expect((await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { note: { issue_city: 'Makkah', due_on_demand: false, due_date: '2026-06-30' } })).statusCode).toBe(200);
  expect((await send('PATCH', `/api/legal/${RAHIM_DEBT}/details`, { debtor: { first_name: 'Rahim', family_name: 'Uddin' }, note: { issue_city: 'الرياض', due_on_demand: true } })).statusCode).toBe(200);
  for (const d of [IMRAN_DEBT, RAHIM_DEBT]) {
    expect((await send('GET', `/api/legal/${d}`)).json().row.missing).toEqual([]);
  }
}, 60_000);
afterAll(async () => {
  await chromium.close();
  await fake?.close();
  await workerPool?.end();
  await t?.close();
});
beforeEach(() => fake.reset());

describe('small rules', () => {
  it('amounts split into riyals and halalas from the text', () => {
    expect(splitAmount('3450.00')).toEqual({ riyals: '3450', halalas: '00' });
    expect(splitAmount('2100.5')).toEqual({ riyals: '2100', halalas: '50' });
    expect(splitAmount('0.75')).toEqual({ riyals: '0', halalas: '75' });
    expect(() => splitAmount('12,00')).toThrow();
  });
  it('dates, cities, phones and values as Najiz shows them', () => {
    expect(najizDate('2025-03-01')).toBe('01/03/2025');
    expect(cityInArabic('Makkah')).toBe('مكة المكرمة');
    expect(cityInArabic('جدة')).toBe('جدة');
    expect(cityInArabic('Atlantis')).toBeNull();
    expect(saudiMobile('+966500000100')).toBe('0500000100');
    expect(plain('١٠,٠٠٠.٠٠ ر.س')).toBe('10000.00ر.س');
  });
});

describe('starting a filing', () => {
  it('only approved notes can be filed', async () => {
    const res = await start([IMRAN_DEBT]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_approved');
  });

  it('approve both notes (5.2)', async () => {
    for (const d of [IMRAN_DEBT, RAHIM_DEBT]) {
      const res = await send('POST', `/api/legal/${d}/approve`, { contact_email: 'owner@demo.example', contact_phone: '0500000100', pledge: true });
      expect(res.statusCode).toBe(200);
    }
  });

  it('viewers cannot start one; another client cannot see the debts', async () => {
    expect((await start([IMRAN_DEBT], {}, viewer)).statusCode).toBe(403);
    expect((await start([IMRAN_DEBT], {}, other)).statusCode).toBe(404);
    expect((await start([IMRAN_DEBT, IMRAN_DEBT])).statusCode).toBe(400);
  });
});

describe('when Najiz looks different, nothing is sent', () => {
  it('a captcha stops the run and tells staff', async () => {
    fake.set({ captchaOn: 'form3' });
    const res = await start([RAHIM_DEBT]);
    expect(res.statusCode).toBe(201);
    const id = res.json().run.id;
    await runWithNafath(id);
    const run = (await send('GET', `/api/najiz/runs/${id}`)).json().run;
    expect(run).toMatchObject({ stage: 'stopped', stop_reason: 'captcha', nafath_number: null });
    expect(run.cases[0]).toMatchObject({ debt_id: RAHIM_DEBT, step: 'stopped', request_number: null });
    expect(fake.requests).toHaveLength(0);
    const note = await t.admin.query(`SELECT data FROM app.notifications WHERE target_id = $1`, [id]);
    expect(note.rows[0].data).toMatchObject({ event: 'najiz_stopped', reason: 'captcha', maybe_sent: 0 });
    // The case is still approved, ready to try again.
    expect((await send('GET', `/api/legal/${RAHIM_DEBT}`)).json().row.stage).toBe('approved');
  }, 30_000);

  it('a changed label stops the run', async () => {
    fake.set({ rename: { from: 'اسم العائلة', to: 'اللقب' } });
    const id = (await start([RAHIM_DEBT])).json().run.id;
    await runWithNafath(id);
    expect((await t.admin.query(`SELECT stage, stop_reason, stop_detail FROM app.najiz_runs WHERE id = $1`, [id])).rows[0]).toMatchObject({
      stage: 'stopped', stop_reason: 'unexpected_page', stop_detail: 'Could not find the field "اسم العائلة"',
    });
    expect(fake.requests).toHaveLength(0);
  }, 30_000);

  it('a value on the review page that differs from Talos stops before sending', async () => {
    fake.set({ reviewIban: 'SA9999999999999999999999' });
    const id = (await start([RAHIM_DEBT])).json().run.id;
    await runWithNafath(id);
    expect((await t.admin.query(`SELECT stop_reason, stop_detail FROM app.najiz_runs WHERE id = $1`, [id])).rows[0]).toEqual({
      stop_reason: 'details_differ', stop_detail: 'On the review page, the IBAN is not the one in Talos',
    });
    expect(fake.requests).toHaveLength(0);
  }, 30_000);

  it('an owner who cannot act for the company stops at the start', async () => {
    fake.set({ companies: ['7000000999'] });
    const id = (await start([RAHIM_DEBT])).json().run.id;
    await runWithNafath(id);
    expect((await t.admin.query(`SELECT stop_reason FROM app.najiz_runs WHERE id = $1`, [id])).rows[0].stop_reason).toBe('company_not_found');
  }, 30_000);
});

describe('Nafath', () => {
  it('the number is shown while the owner chooses it, and forgotten after', async () => {
    const id = (await start([RAHIM_DEBT])).json().run.id;
    const done = makeWorker({ nafathSeconds: 30 }).tick();
    await until(async () => (await stageOf(id)) === 'waiting_nafath');
    const run = (await send('GET', `/api/najiz/runs/${id}`)).json().run;
    expect(run).toMatchObject({ stage: 'waiting_nafath', nafath_number: '42', owner_phone_last4: '0100', nafath_sent: false });
    expect(JSON.stringify(run)).not.toContain('1000000100'); // never the owner's ID number
    // Staff press stop while the owner has not chosen yet.
    const cancelled = await send('POST', `/api/najiz/runs/${id}/cancel`, {});
    expect(cancelled.json().run).toMatchObject({ stage: 'stopped', stop_reason: 'cancelled', nafath_number: null });
    await done;
    expect(await stageOf(id)).toBe('stopped');
    expect(fake.requests).toHaveLength(0);
  }, 30_000);

  it('when the owner does not choose in time, the sign-in expires', async () => {
    const id = (await start([RAHIM_DEBT])).json().run.id;
    await makeWorker({ nafathSeconds: 1 }).tick();
    expect((await t.admin.query(`SELECT stage, nafath_number, finished_at FROM app.najiz_runs WHERE id = $1`, [id])).rows[0]).toMatchObject({
      stage: 'expired', nafath_number: null,
    });
  }, 30_000);
});

describe('filing', () => {
  it('one sign-in at a time per client', async () => {
    const first = await start([IMRAN_DEBT]);
    expect(first.statusCode).toBe(201);
    const second = await start([RAHIM_DEBT]);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('najiz_busy');
    // The case shows as being filed.
    const list = (await send('GET', '/api/legal')).json().items;
    expect(list.find((x: { debt_id: string }) => x.debt_id === IMRAN_DEBT).stage).toBe('filing');
    await send('POST', `/api/najiz/runs/${first.json().run.id}/cancel`, {});
  });

  it('files two notes in one sign-in, typing exactly what Talos has', async () => {
    const res = await start([IMRAN_DEBT, RAHIM_DEBT], {}, owner);
    expect(res.statusCode).toBe(201);
    expect(res.json().run.cases.map((c: { step: string; amount: string }) => [c.step, c.amount])).toEqual([
      ['waiting', '3450.00'], ['waiting', '2100.00'],
    ]);
    const id = res.json().run.id;
    await runWithNafath(id);

    const run = (await send('GET', `/api/najiz/runs/${id}`)).json().run;
    expect(run.stage).toBe('done');
    expect(run.cases.map((c: { step: string }) => c.step)).toEqual(['sent', 'sent']);
    expect(fake.requests).toHaveLength(2);
    const [imran, rahim] = fake.requests;
    expect(imran!.fields).toMatchObject({
      company: '7000000001', category: 'تنفيذ مالي', main: 'أوراق تجارية', sub: 'سند لأمر', capacity: 'بالنيابة عن جهة اعتبارية', pledge: 'on',
      entity: 'شركة مسجلة في وزارة التجارة', unified: '7000000001', representation: 'ممثل نظامي',
      email: 'owner@demo.example', mobile: '0500000100', bank: 'Demo Bank', iban: 'SA0000000000000000000000',
      nationality: 'باكستان', id_type: 'إقامة', id_number: '2000000001', first: 'Imran', father: 'Ali', family: 'Khan', work: 'لا',
      // The note says 10,000; 3,450 is left, so 6,550 was received.
      face_r: '10000', face_h: '00', part: 'نعم', received_r: '6550', received_h: '00', remaining_r: '3450', remaining_h: '00', all: 'نعم',
      currency: 'ريال سعودي', note_number: 'NAFITH-DEMO-0001', issue_country: 'المملكة العربية السعودية',
      issue_city: 'مكة المكرمة', payment_place: 'مكة المكرمة', due: 'مستحق في تاريخ', due_date: '30/06/2026',
    });
    expect(imran!.files.cr).toMatchObject({ name: 'cr.pdf', type: 'application/pdf' });
    expect(imran!.files.note).toMatchObject({ name: 'note-imran.pdf', type: 'application/pdf' });
    expect(imran!.files.contract).toBeUndefined();
    expect(rahim!.fields).toMatchObject({
      nationality: 'بنغلاديش', first: 'Rahim', family: 'Uddin', issue_city: 'الرياض', payment_place: 'الرياض',
      due: 'مستحق عند الاطلاع', remaining_r: '2100',
    });
    expect(rahim!.fields.due_date).toBeUndefined();

    // Saved in Talos: the number on the case, the debt in legal, the history, the confirmation picture.
    for (const [debt, number] of [[IMRAN_DEBT, imran!.number], [RAHIM_DEBT, rahim!.number]] as const) {
      const c = (await send('GET', `/api/legal/${debt}`)).json();
      expect(c.row).toMatchObject({ stage: 'submitted', najiz_request_number: number });
      expect(c.events[0]).toMatchObject({ status: 'submitted', source: 'najiz_filing' });
      const d = await t.admin.query(`SELECT status FROM app.debts WHERE id = $1`, [debt]);
      expect(d.rows[0].status).toBe('in_legal');
      const receipt = await t.admin.query(`SELECT mime_type, source FROM app.documents WHERE debt_id = $1 AND doc_type = 'najiz_receipt'`, [debt]);
      expect(receipt.rows).toEqual([{ mime_type: 'image/png', source: 'system_generated' }]);
      const note = await t.admin.query(`SELECT data FROM app.notifications WHERE target_id = $1 AND data->>'event' = 'najiz_filed'`, [debt]);
      expect(note.rows[0].data).toMatchObject({ number });
    }
    // Najiz rule 5: every step is in the audit log, with who started it.
    const audit = await t.admin.query(
      `SELECT count(*)::int AS n FROM audit.activity_log WHERE target_table = 'app.najiz_runs' AND target_id = $1`, [id],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(4);
    // Filed notes cannot be filed again.
    expect((await start([IMRAN_DEBT])).json().error).toBe('not_approved');
  }, 60_000);

  it('another client never sees a run', async () => {
    const { rows } = await t.admin.query(`SELECT id FROM app.najiz_runs LIMIT 1`);
    expect((await send('GET', `/api/najiz/runs/${rows[0].id}`, undefined, other)).statusCode).toBe(404);
    expect((await send('POST', `/api/najiz/runs/${rows[0].id}/cancel`, {}, other)).statusCode).toBe(404);
  });
});

describe('a note that may already be on Najiz is never filed twice by accident', () => {
  const PAPER = '66666666-6666-4666-8666-000000000077';

  beforeAll(async () => {
    // A third note for Rahim, approved, for these tests.
    await t.admin.query(
      `INSERT INTO app.instruments (id, client_id, debtor_id, type_code, reference_number, issue_date, face_amount, issue_city, issue_country, due_on_demand)
       VALUES ('55555555-5555-4555-8555-000000000077', $1, '33333333-3333-4333-8333-000000000003', 'paper_promissory_note', 'PAPER-77', '2025-01-10', 900, 'Jeddah', 'SA', true)`,
      [CLIENT],
    );
    await t.admin.query(
      `INSERT INTO app.debts (id, client_id, debtor_id, instrument_id, ref_code, reason, amount_original, amount_outstanding, status)
       VALUES ($1, $2, '33333333-3333-4333-8333-000000000003', '55555555-5555-4555-8555-000000000077', 'DBT-2026-0077', 'Damages', 900, 900, 'legal_ready')`,
      [PAPER, CLIENT],
    );
    await upload({ doc_type: 'promissory_note', debt_id: PAPER }, await onePagePdf('NOTE 77'), 'note-77.pdf');
    const ok = await send('POST', `/api/legal/${PAPER}/approve`, { contact_email: 'owner@demo.example', contact_phone: '0500000100', pledge: true });
    expect(ok.statusCode).toBe(200);
  });

  it('no confirmation after "send": the note keeps "sending" and staff must check Najiz first', async () => {
    fake.set({ hangAfterSend: true });
    const id = (await start([PAPER])).json().run.id;
    await runWithNafath(id, makeWorker({ sendTimeoutMs: 1000 }));
    const run = (await send('GET', `/api/najiz/runs/${id}`)).json().run;
    expect(run.stage).toBe('stopped');
    expect(run.cases[0].step).toBe('sending');
    expect(run.cases[0].error).toContain('Check on Najiz whether this request was sent');
    const note = await t.admin.query(`SELECT data FROM app.notifications WHERE target_id = $1`, [id]);
    expect(note.rows[0].data).toMatchObject({ event: 'najiz_stopped', maybe_sent: 1 });

    const again = await start([PAPER]);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('najiz_check_first');
    // Staff looked on Najiz: it is not there.
    const checked = await start([PAPER], { checked_not_on_najiz: true });
    expect(checked.statusCode).toBe(201);
    await send('POST', `/api/najiz/runs/${checked.json().run.id}/cancel`, {});
  }, 30_000);

  it('a run whose worker stopped answering is stopped, and staff are told', async () => {
    const id = (await start([PAPER])).json().run.id;
    await t.admin.query(
      `UPDATE app.najiz_runs SET stage = 'working', claimed_by = 'gone', heartbeat_at = now() - interval '30 minutes' WHERE id = $1`, [id],
    );
    await t.admin.query(`UPDATE app.najiz_run_items SET step = 'sending' WHERE run_id = $1`, [id]);
    expect(await recoverLostRuns(workerPool, 5)).toBe(1);
    const run = (await send('GET', `/api/najiz/runs/${id}`)).json().run;
    expect(run).toMatchObject({ stage: 'stopped', stop_reason: 'worker_lost' });
    expect(run.cases[0].step).toBe('sending');
    expect((await start([PAPER])).json().error).toBe('najiz_check_first');
  });
});

describe('status checks (5.5): one Nafath approval reads every request', () => {
  const check = (payload: Record<string, unknown> = {}, headers = staff) => send('POST', '/api/najiz/checks', payload, headers);

  it('viewers cannot start one; a client with nothing on Najiz is told so', async () => {
    expect((await check({}, viewer)).statusCode).toBe(403);
    const none = await check({}, other);
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('nothing_to_check');
  });

  it('reads the status and circuit of each request, and tells the client what changed', async () => {
    const res = await check();
    expect(res.statusCode).toBe(201);
    const run = res.json().run;
    expect(run.kind).toBe('status_check');
    const numbers = fake.requests.map((x) => x.number);
    expect(run.cases.map((c: { request_number: string }) => c.request_number)).toEqual(numbers);
    // Najiz shows a new status for the first request.
    fake.statuses.set(numbers[0]!, { status: 'قيد المعالجة', circuit: 'دائرة التنفيذ الأولى' });
    await runWithNafath(run.id);

    const after = (await send('GET', `/api/najiz/runs/${run.id}`)).json().run;
    expect(after.stage).toBe('done');
    expect(after.cases.map((c: { step: string; najiz_status: string }) => [c.step, c.najiz_status])).toEqual([
      ['checked', 'قيد المعالجة'], ['checked', 'قيد التنفيذ'],
    ]);
    const imran = (await send('GET', `/api/legal/${IMRAN_DEBT}`)).json();
    expect(imran.row).toMatchObject({ stage: 'submitted', najiz_status: 'قيد المعالجة', najiz_circuit: 'دائرة التنفيذ الأولى' });
    expect(imran.row.najiz_status_checked_at).not.toBeNull();
    expect(imran.events[0]).toMatchObject({ status: 'submitted', najiz_status: 'قيد المعالجة', source: 'najiz_check' });
    const notes = await t.admin.query(`SELECT data FROM app.notifications WHERE data->>'event' = 'najiz_status' ORDER BY created_at`);
    expect(notes.rows.map((x) => x.data.status)).toEqual(['قيد المعالجة', 'قيد التنفيذ']);
  }, 60_000);

  it('a second round adds history only for what changed', async () => {
    const numbers = fake.requests.map((x) => x.number);
    fake.statuses.set(numbers[1]!, { status: 'منتهي', circuit: 'دائرة التنفيذ الثالثة' });
    const run = (await check({ debt_ids: [IMRAN_DEBT, RAHIM_DEBT] })).json().run;
    await runWithNafath(run.id);
    expect(await stageOf(run.id)).toBe('done');
    const events = await t.admin.query(
      `SELECT l.debt_id, count(*)::int AS n FROM app.legal_case_events e JOIN app.legal_cases l ON l.id = e.legal_case_id
        WHERE e.source = 'najiz_check' GROUP BY l.debt_id`,
    );
    const byDebt = Object.fromEntries(events.rows.map((x) => [x.debt_id, x.n]));
    expect(byDebt).toEqual({ [IMRAN_DEBT]: 1, [RAHIM_DEBT]: 2 });
    // Any status Najiz shows is kept as Najiz writes it.
    expect((await send('GET', `/api/legal/${RAHIM_DEBT}`)).json().row.najiz_status).toBe('منتهي');
  }, 60_000);

  it('a request Najiz cannot find stops the round and tells staff', async () => {
    await t.admin.query(`UPDATE app.legal_cases SET najiz_request_number = '9999999999' WHERE debt_id = $1`, [RAHIM_DEBT]);
    const run = (await check({ debt_ids: [RAHIM_DEBT] })).json().run;
    await runWithNafath(run.id);
    expect((await t.admin.query(`SELECT stage, stop_reason FROM app.najiz_runs WHERE id = $1`, [run.id])).rows[0]).toEqual({
      stage: 'stopped', stop_reason: 'unexpected_page',
    });
    const note = await t.admin.query(`SELECT data FROM app.notifications WHERE target_id = $1`, [run.id]);
    expect(note.rows[0].data).toMatchObject({ event: 'najiz_stopped', kind: 'status_check' });
  }, 30_000);
});
