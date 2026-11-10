/**
 * Phase 5: legal debts on their way to Najiz.
 *   5.2 the client approves the filing (only when nothing Najiz needs is missing)
 *   5.3 statuses entered by hand, with the history
 * Money stays text; another client's cases are never seen or changed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { missingForNajiz, type ReadinessFacts } from '../src/legal/readiness.js';
import { as, CLIENT, multipart, other, OWNER, PDF, PNG, staff, startApp, SURESH_DEBT, viewer, type TestApp } from './helpers.js';

const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001'; // Nafith note NAFITH-DEMO-0001 (10,000), owes 3,450
const RAHIM_DEBT = '66666666-6666-4666-8666-000000000003'; // paper note, owes 2,100
const owner = as(CLIENT, OWNER);

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
  // Imran, Rahim and Suresh have had every reminder with no reply.
  await t.admin.query(`UPDATE app.debts SET status = 'legal_ready' WHERE id = ANY($1)`, [[IMRAN_DEBT, RAHIM_DEBT, SURESH_DEBT]]);
});
afterAll(async () => {
  await t?.close();
});

const get = (url: string, headers = staff) => t.app.inject({ method: 'GET', url, headers });
const send = (method: 'POST' | 'PATCH', url: string, payload: unknown, headers = staff) =>
  t.app.inject({ method, url, headers, payload: payload as Record<string, unknown> });
const approve = (debt: string, body: Record<string, unknown> = {}, headers = staff) =>
  send('POST', `/api/legal/${debt}/approve`, { contact_email: 'owner@demo.example', contact_phone: '0500000100', pledge: true, ...body }, headers);
async function upload(fields: Record<string, string>, bytes = PDF, name = 'file.pdf') {
  const body = multipart(fields, { name, bytes });
  const res = await t.app.inject({ method: 'POST', url: '/api/documents', headers: { ...staff, ...body.headers }, payload: body.payload });
  expect(res.statusCode).toBe(201);
}

describe('what Najiz still needs', () => {
  const full: ReadinessFacts = {
    owner_id_number: '1000000100', unified_number: '7000000001', iban: 'SA0000000000000000000000', bank_name: 'Demo Bank',
    cr_mime: 'application/pdf', debtor_first_name: 'Imran', debtor_family_name: 'Khan', debtor_id_type: 'iqama',
    debtor_id_number: '2000000001', debtor_nationality: 'PK', instrument_type: 'nafith_promissory_note', note_mime: 'application/pdf',
    issue_city: 'Jeddah', issue_date: '2025-03-01', due_date: null, due_on_demand: true,
  };
  it('nothing when every detail is there; on demand needs no due date', () => {
    expect(missingForNajiz(full)).toEqual([]);
  });
  it('lists each missing detail in the order Najiz asks for it', () => {
    expect(missingForNajiz({ ...full, owner_id_number: null, cr_mime: 'image/png', debtor_first_name: ' ', due_on_demand: false })).toEqual([
      'owner_id', 'cr_file', 'debtor_name', 'note_due',
    ]);
  });
  it('a debt without a promissory note cannot be filed here', () => {
    expect(missingForNajiz({ ...full, instrument_type: 'cheque', note_mime: null, issue_city: null })).toEqual(['note_type']);
  });
});

describe('the legal list and case page', () => {
  it('lists legal debts with what is missing, and amounts as text', async () => {
    const res = await get('/api/legal');
    expect(res.statusCode).toBe(200);
    const imran = res.json().items.find((x: { debt_id: string }) => x.debt_id === IMRAN_DEBT);
    expect(imran).toMatchObject({
      stage: 'missing', amount_outstanding: '3450.00', instrument_type: 'nafith_promissory_note', case_id: null,
      // The seed has no commercial registration file, no copy of the note, and no due date on the note.
      missing: ['cr_file', 'note_file', 'note_due'],
    });
    const suresh = res.json().items.find((x: { debt_id: string }) => x.debt_id === SURESH_DEBT);
    expect(suresh.missing).toContain('note_type');
  });

  it('another client sees none of it', async () => {
    expect((await get('/api/legal', other)).json().items).toEqual([]);
    expect((await get(`/api/legal/${IMRAN_DEBT}`, other)).statusCode).toBe(404);
  });

  it('the case page shows only the last four digits of the owner ID, and what was already received', async () => {
    const res = await get(`/api/legal/${IMRAN_DEBT}`, viewer);
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.company).toMatchObject({ unified_number: '7000000001', owner_id_type: 'national_id', owner_id_last4: '0100' });
    expect(JSON.stringify(c)).not.toContain('1000000100');
    expect(c.debtor).toMatchObject({ first_name: 'Imran', family_name: 'Khan', nationality: 'PK' });
    // The note says 10,000; 3,450 is left, so 6,550 counts as received.
    expect(c.amounts).toEqual({ claimed: '3450.00', received: '6550.00' });
    expect(c.note).toMatchObject({ issue_city: 'Jeddah', due_on_demand: false, face_amount: '10000.00' });
    expect(c.approval).toBeNull();
  });

  it('a debt that is not legal has no case page', async () => {
    expect((await get('/api/legal/66666666-6666-4666-8666-000000000002')).statusCode).toBe(404);
  });
});

describe('filling in what is missing', () => {
  it('the note: place and due type', async () => {
    const res = await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { note: { issue_city: 'Jeddah', due_on_demand: false } });
    expect(res.statusCode).toBe(400);
    const ok = await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { note: { issue_city: 'Makkah', due_on_demand: false, due_date: '2026-06-30' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().note).toMatchObject({ issue_city: 'Makkah', issue_country: 'SA', due_date: '2026-06-30' });
    expect(ok.json().row.missing).toEqual(['cr_file', 'note_file']);
  });

  it('the debtor name in parts', async () => {
    const res = await send('PATCH', `/api/legal/${RAHIM_DEBT}/details`, { debtor: { first_name: 'Rahim', family_name: 'Uddin', father_name: 'Karim' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().debtor).toMatchObject({ first_name: 'Rahim', father_name: 'Karim', grandfather_name: null, family_name: 'Uddin' });
  });

  it('company details: owners and admins only, and the ID must match its type', async () => {
    const company = { owner_id_type: 'iqama', owner_id_number: '1000000100', unified_number: '7000000001' };
    expect((await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { company }, staff)).statusCode).toBe(403);
    expect((await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { company }, owner)).statusCode).toBe(400);
    expect((await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { company: { ...company, owner_id_type: 'national_id', unified_number: '4030000000' } }, owner)).statusCode).toBe(400);
    const ok = await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { company: { ...company, owner_id_type: 'national_id' } }, owner);
    expect(ok.statusCode).toBe(200);
  });

  it('viewers and other clients cannot change anything', async () => {
    const body = { debtor: { first_name: 'X', family_name: 'Y' } };
    expect((await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, body, viewer)).statusCode).toBe(403);
    expect((await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, body, other)).statusCode).toBe(404);
  });
});

describe('approving the filing (5.2)', () => {
  it('is refused while anything Najiz needs is missing', async () => {
    const res = await approve(IMRAN_DEBT);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'najiz_details_missing', missing: ['cr_file', 'note_file'] });
    const cases = await t.admin.query(`SELECT 1 FROM app.legal_cases WHERE debt_id = $1`, [IMRAN_DEBT]);
    expect(cases.rowCount).toBe(0);
  });

  it('a photo of a document does not count: Najiz takes PDF files', async () => {
    await upload({ doc_type: 'cr' }, PNG, 'cr.png');
    const res = await get(`/api/legal/${IMRAN_DEBT}`);
    expect(res.json().row.missing).toContain('cr_file');
  });

  it('once the files are PDFs, the debt is ready to approve', async () => {
    await upload({ doc_type: 'cr' }, PDF, 'cr.pdf');
    await upload({ doc_type: 'promissory_note', debt_id: IMRAN_DEBT }, PDF, 'note.pdf');
    const res = await get(`/api/legal/${IMRAN_DEBT}`);
    expect(res.json().row).toMatchObject({ stage: 'to_approve', missing: [] });
    expect(res.json().files.cr).toMatchObject({ mime_type: 'application/pdf', file_name: 'cr.pdf' });
    expect(res.json().files.promissory_note).toMatchObject({ file_name: 'note.pdf' });
  });

  it('needs the pledge, a real email and a real mobile', async () => {
    expect((await approve(IMRAN_DEBT, { pledge: false })).statusCode).toBe(400);
    expect((await approve(IMRAN_DEBT, { contact_email: 'nope' })).statusCode).toBe(400);
    expect((await approve(IMRAN_DEBT, { contact_phone: '123' })).statusCode).toBe(400);
  });

  it('viewers and other clients cannot approve', async () => {
    expect((await approve(IMRAN_DEBT, {}, viewer)).statusCode).toBe(403);
    expect((await approve(IMRAN_DEBT, {}, other)).statusCode).toBe(404);
  });

  it('approval makes the case, with the amounts as text, and records who approved it', async () => {
    const res = await approve(IMRAN_DEBT, { contact_email: 'Owner@Demo.example' });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.row.stage).toBe('approved');
    expect(c.amounts).toEqual({ claimed: '3450.00', received: '6550.00' });
    expect(c.approval).toMatchObject({ approved_by_name: 'Demo Collections Staff', contact_email: 'owner@demo.example', contact_phone: '+966500000100' });
    expect(c.events).toHaveLength(1);
    expect(c.events[0]).toMatchObject({ status: 'approved', source: 'staff', recorded_by_name: 'Demo Collections Staff' });
    const row = await t.admin.query(
      `SELECT status, amount_claimed::text, najiz_main_type, najiz_sub_type, court_name, approved_by FROM app.legal_cases WHERE debt_id = $1`,
      [IMRAN_DEBT],
    );
    expect(row.rows[0]).toMatchObject({ status: 'approved', amount_claimed: '3450.00', najiz_main_type: 'أوراق تجارية', najiz_sub_type: 'سند لأمر', court_name: 'محكمة التنفيذ' });
    // The audit log has the approval with the person who made it.
    const log = await t.admin.query(
      `SELECT actor_id, action FROM audit.activity_log WHERE target_table = 'app.legal_cases' AND target_id = $1 ORDER BY id DESC LIMIT 1`,
      [c.row.case_id],
    );
    expect(log.rows[0]).toMatchObject({ actor_id: '22222222-2222-4222-8222-000000000002', action: 'legal_cases.insert' });
  });

  it('approving twice is refused, and the details are locked after approval', async () => {
    expect((await approve(IMRAN_DEBT)).json().error).toBe('already_approved');
    const res = await send('PATCH', `/api/legal/${IMRAN_DEBT}/details`, { note: { issue_city: 'Riyadh', due_on_demand: true } });
    expect(res.statusCode).toBe(409);
  });

  it('a debt with a cheque, not a promissory note, cannot be approved here', async () => {
    const res = await approve(SURESH_DEBT);
    expect(res.statusCode).toBe(409);
    expect(res.json().missing).toEqual(expect.arrayContaining(['note_type']));
  });
});

describe('status entered by hand (5.3)', () => {
  it('only after approval', async () => {
    const res = await send('POST', `/api/legal/${RAHIM_DEBT}/status`, { status: 'submitted', najiz_request_number: '401014800000002' });
    expect(res.statusCode).toBe(409);
  });

  it('submitting needs the request number from Najiz, digits only', async () => {
    expect((await send('POST', `/api/legal/${IMRAN_DEBT}/status`, { status: 'submitted' })).statusCode).toBe(400);
    expect((await send('POST', `/api/legal/${IMRAN_DEBT}/status`, { status: 'submitted', najiz_request_number: '40-10' })).statusCode).toBe(400);
  });

  it('saves the number, moves the debt to "in legal", and adds to the history', async () => {
    const res = await send('POST', `/api/legal/${IMRAN_DEBT}/status`, { status: 'submitted', najiz_request_number: '401014800000001', note: 'Filed by hand on Najiz' });
    expect(res.statusCode).toBe(200);
    const c = res.json();
    expect(c.row).toMatchObject({ stage: 'submitted', najiz_request_number: '401014800000001' });
    expect(c.row.submitted_at).toBeTruthy();
    expect(c.events.map((e: { status: string }) => e.status)).toEqual(['submitted', 'approved']);
    expect(c.events[0].note).toBe('Filed by hand on Najiz');
    const debt = await t.admin.query(`SELECT status FROM app.debts WHERE id = $1`, [IMRAN_DEBT]);
    expect(debt.rows[0].status).toBe('in_legal');
  });

  it('a later status keeps the number', async () => {
    const res = await send('POST', `/api/legal/${IMRAN_DEBT}/status`, { status: 'order_issued' });
    expect(res.statusCode).toBe(200);
    expect(res.json().row).toMatchObject({ stage: 'order_issued', najiz_request_number: '401014800000001' });
  });

  it('a request number is never saved on two cases', async () => {
    await t.admin.query(`UPDATE app.instruments SET issue_city = 'Jeddah', due_on_demand = true WHERE id = '55555555-5555-4555-8555-000000000002'`);
    await upload({ doc_type: 'promissory_note', debt_id: RAHIM_DEBT }, PDF, 'rahim-note.pdf');
    expect((await approve(RAHIM_DEBT)).statusCode).toBe(200);
    const res = await send('POST', `/api/legal/${RAHIM_DEBT}/status`, { status: 'submitted', najiz_request_number: '401014800000001' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('number_in_use');
  });

  it('viewers and other clients cannot add a status', async () => {
    expect((await send('POST', `/api/legal/${IMRAN_DEBT}/status`, { status: 'closed' }, viewer)).statusCode).toBe(403);
    expect((await send('POST', `/api/legal/${IMRAN_DEBT}/status`, { status: 'closed' }, other)).statusCode).toBe(404);
  });

  it('the history cannot be changed through the API account', async () => {
    const q = t.pool.connect();
    const db = await q;
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.client_id', $1, true)`, [CLIENT]);
      await expect(db.query(`UPDATE app.legal_case_events SET note = 'changed'`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.query('ROLLBACK');
      db.release();
    }
  });
});

describe('files Najiz takes', () => {
  it('a PDF over 0.95 MB counts as missing, because Najiz refuses it', () => {
    const facts: ReadinessFacts = {
      owner_id_number: '1000000100', unified_number: '7000000001', iban: 'SA0000000000000000000000', bank_name: 'Demo Bank',
      cr_mime: 'application/pdf', cr_size: 900_000, debtor_first_name: 'Imran', debtor_family_name: 'Khan', debtor_id_type: 'iqama',
      debtor_id_number: '2000000001', debtor_nationality: 'PK', instrument_type: 'nafith_promissory_note', note_mime: 'application/pdf',
      note_size: 996_147, issue_city: 'Jeddah', issue_date: '2025-03-01', due_date: null, due_on_demand: true,
    };
    expect(missingForNajiz(facts)).toEqual([]);
    expect(missingForNajiz({ ...facts, cr_size: 1_200_000, note_size: 996_148 })).toEqual(['cr_file', 'note_file']);
  });
});
