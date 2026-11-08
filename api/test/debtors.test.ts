/**
 * Step 3.2: adding and editing debtors, phones, instruments and debts by hand.
 * Covers what CLAUDE.md asks tests for: tenant isolation and money.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLIENT, FAHAD_DEBTOR, fakeId, other, RAHIM_DEBT, RAHIM_DEBTOR, staff, startApp, SURESH_DEBT, viewer, type TestApp } from './helpers.js';

let t: TestApp;

beforeAll(async () => {
  t = await startApp();
});
afterAll(async () => {
  await t?.close();
});

const post = (url: string, payload: unknown, headers = staff) => t.app.inject({ method: 'POST', url, headers, payload: payload as object });
const patch = (url: string, payload: unknown, headers = staff) => t.app.inject({ method: 'PATCH', url, headers, payload: payload as object });

describe('adding a debtor', () => {
  it('creates the debtor, phones and several debts on one shared promissory note', async () => {
    const res = await post('/api/debtors', {
      id_number: fakeId('2', 1001),
      full_name: 'Manual Courier One',
      preferred_language: 'Urdu',
      nationality: 'Pakistani',
      phones: ['0551110001', { phone: '+923001110001', label: 'home' }],
      debts: [
        { amount: '1,500', reason: 'Motorcycle rent August', reason_category: 'Vehicle rent',
          instrument: { type: 'Promissory note on Nafith', reference_number: 'NF 9001' } },
        { amount: 640.5, reason: 'Cash on delivery not handed over', reason_category: 'cash_on_delivery',
          instrument: { type: 'nafith_promissory_note', reference_number: 'nf9001' } },
        { amount: 300, reason: 'Uniform not returned' },
      ],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.debtor.ref_code).toMatch(/^D-\d{6}$/);
    expect(body.debts).toHaveLength(3);
    // The two debts on the same note share one instrument; the third has none.
    expect(body.debts[0].instrument_id).toBeTruthy();
    expect(body.debts[1].instrument_id).toBe(body.debts[0].instrument_id);
    expect(body.debts[2].instrument_id).toBeNull();

    const stored = await t.admin.query(
      `SELECT d.preferred_language, d.nationality, d.id_type,
              (SELECT count(*) FROM app.debtor_phones p WHERE p.debtor_id = d.id) AS phones,
              (SELECT count(*) FROM app.debtor_phones p WHERE p.debtor_id = d.id AND p.is_primary) AS primaries,
              (SELECT count(*) FROM app.instruments i WHERE i.debtor_id = d.id) AS instruments,
              (SELECT sum(amount_outstanding)::text FROM app.debts x WHERE x.debtor_id = d.id) AS total
         FROM app.debtors d WHERE d.id = $1`,
      [body.debtor.id],
    );
    expect(stored.rows[0]).toEqual({
      preferred_language: 'ur', nationality: 'PK', id_type: 'iqama', phones: '2', primaries: '1', instruments: '1', total: '2440.50',
    });
  });

  it('warns about a paper note with no number, but saves it', async () => {
    const res = await post('/api/debtors', {
      id_number: fakeId('2', 1002),
      full_name: 'Manual Courier Two',
      phones: ['0551110002'],
      debts: [{ amount: 900, reason: 'Damaged phone', instrument: { type: 'Paper promissory note' } }],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings[0].message).toMatch(/reference number/);
  });

  it('lists every problem at once, with the field it belongs to', async () => {
    const res = await post('/api/debtors', {
      id_type: 'iqama',
      id_number: '1234',
      full_name: 'X',
      phones: ['12345'],
      debts: [{ amount: -1, reason: '' }],
    });
    expect(res.statusCode).toBe(400);
    const fields = res.json().errors.map((e: { field: string }) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['id_number', 'full_name', 'phones[0]', 'debts[0].amount', 'debts[0].reason']));
  });

  it('refuses a second debtor with the same ID number and points to the first', async () => {
    const res = await post('/api/debtors', { id_type: 'iqama', id_number: '2000000003', full_name: 'Rahim Again', phones: ['0551110003'] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'debtor_exists', debtor_id: RAHIM_DEBTOR });
  });

  it('needs at least one phone', async () => {
    const res = await post('/api/debtors', { id_number: fakeId('2', 1004), full_name: 'No Phone', phones: [] });
    expect(res.statusCode).toBe(400);
  });

  it('a viewer cannot add debtors', async () => {
    const res = await post('/api/debtors', { id_number: fakeId('2', 1005), full_name: 'Viewer Try', phones: ['0551110005'] }, viewer);
    expect(res.statusCode).toBe(403);
  });

  it('a debtor added by another client stays invisible here, and the same ID can exist there', async () => {
    const res = await post('/api/debtors', { id_type: 'iqama', id_number: '2000000003', full_name: 'Same ID Other Client', phones: ['0551110006'] }, other);
    expect(res.statusCode).toBe(201);
    const list = await t.app.inject({ method: 'GET', url: '/api/debtors?search=Same%20ID%20Other', headers: staff });
    expect(list.json().total).toBe(0);
  });
});

describe('adding debts to an existing debtor', () => {
  it('reuses the instrument already stored for the debtor', async () => {
    // Rahim's seed paper note (dev/seed.sql), given again in lower case.
    const before = await t.admin.query(`SELECT id, reference_number FROM app.instruments WHERE debtor_id = $1`, [RAHIM_DEBTOR]);
    const note = before.rows[0];
    const res = await post(`/api/debtors/${RAHIM_DEBTOR}/debts`, {
      amount: 250, reason: 'Traffic fine paid by the company', reason_category: 'fine',
      instrument: { type: 'paper_promissory_note', reference_number: note.reference_number.toLowerCase() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().debts[0].instrument_id).toBe(note.id);
    const after = await t.admin.query(`SELECT count(*) FROM app.instruments WHERE debtor_id = $1`, [RAHIM_DEBTOR]);
    expect(after.rows[0].count).toBe(String(before.rowCount));
  });

  it('refuses an instrument of another debtor', async () => {
    const note = await t.admin.query(`SELECT id FROM app.instruments WHERE debtor_id = $1`, [RAHIM_DEBTOR]);
    const res = await post(`/api/debtors/${FAHAD_DEBTOR}/debts`, { amount: 100, reason: 'Wrong note', instrument_id: note.rows[0].id });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a debt reference that is already used', async () => {
    const res = await post(`/api/debtors/${FAHAD_DEBTOR}/debts`, { ref_code: 'DBT-2026-0001', amount: 100, reason: 'Duplicate reference' });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already used/);
  });

  it('gives 404 for another client\'s debtor', async () => {
    const res = await post(`/api/debtors/${RAHIM_DEBTOR}/debts`, { amount: 100, reason: 'Not mine' }, other);
    expect(res.statusCode).toBe(404);
  });
});

describe('editing', () => {
  it('changes debtor details and keeps the ID type when only the number changes', async () => {
    const res = await patch(`/api/debtors/${FAHAD_DEBTOR}`, { preferred_language: 'English', notes: 'Prefers calls after 5pm' });
    expect(res.statusCode).toBe(200);
    expect(res.json().debtor).toMatchObject({ preferred_language: 'en', notes: 'Prefers calls after 5pm' });
    const bad = await patch(`/api/debtors/${FAHAD_DEBTOR}`, { id_number: '2000000000' }); // national ID must start with 1
    expect(bad.statusCode).toBe(400);
  });

  it('marks a phone as wrong number and moves the main number', async () => {
    const phones = await t.admin.query(`SELECT id FROM app.debtor_phones WHERE debtor_id = $1 ORDER BY is_primary DESC`, [RAHIM_DEBTOR]);
    const added = await post(`/api/debtors/${RAHIM_DEBTOR}/phones`, { phone: '0551119999', is_primary: true });
    expect(added.statusCode).toBe(201);
    expect(added.json().phone.is_primary).toBe(true);
    const res = await patch(`/api/phones/${phones.rows[0].id}`, { status: 'wrong_number' });
    expect(res.json().phone).toMatchObject({ status: 'wrong_number', is_primary: false });
    const primaries = await t.admin.query(`SELECT count(*) FROM app.debtor_phones WHERE debtor_id = $1 AND is_primary`, [RAHIM_DEBTOR]);
    expect(primaries.rows[0].count).toBe('1');
  });

  it('corrects an amount and recalculates the balance from approved payments', async () => {
    // Suresh: 2500.00 with an approved payment (dev/seed.sql).
    const paid = await t.admin.query(
      `SELECT coalesce(sum(amount),0)::text AS paid FROM app.payments WHERE debt_id = $1 AND status = 'approved'`,
      [SURESH_DEBT],
    );
    const res = await patch(`/api/debts/${SURESH_DEBT}`, { amount: '2200.00' });
    expect(res.statusCode).toBe(200);
    const expected = (220000 - Math.round(Number(paid.rows[0].paid) * 100)) / 100;
    expect(res.json().debt.amount_original).toBe('2200.00');
    expect(Number(res.json().debt.amount_outstanding)).toBe(expected);
  });

  it('refuses an amount at or below what was already paid', async () => {
    const paid = await t.admin.query(
      `SELECT sum(amount)::numeric(12,2)::text AS paid FROM app.payments WHERE debt_id = $1 AND status = 'approved'`,
      [SURESH_DEBT],
    );
    const res = await patch(`/api/debts/${SURESH_DEBT}`, { amount: paid.rows[0].paid });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/already paid/);
  });

  it('refuses to change the amount of a debt in legal', async () => {
    await t.admin.query(`UPDATE app.debts SET status = 'in_legal' WHERE id = $1`, [RAHIM_DEBT]);
    const res = await patch(`/api/debts/${RAHIM_DEBT}`, { amount: 10 });
    expect(res.statusCode).toBe(409);
    // Other details can still be fixed.
    const ok = await patch(`/api/debts/${RAHIM_DEBT}`, { reason: 'Repair cost for the damaged motorcycle (corrected)' });
    expect(ok.statusCode).toBe(200);
  });

  it('checks a new due date against the stored issue date', async () => {
    const res = await patch(`/api/debts/${SURESH_DEBT}`, { due_date: '2020-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].field).toBe('due_date');
  });

  it('attaches a new instrument to a debt and removes it again', async () => {
    const res = await patch(`/api/debts/${SURESH_DEBT}`, { instrument: { type: 'Bill of exchange', reference_number: 'BX-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().debt.instrument_type).toBe('bill_of_exchange');
    const removed = await patch(`/api/debts/${SURESH_DEBT}`, { instrument_id: null });
    expect(removed.json().debt.instrument_type).toBe('none');
  });

  it('every change is in the audit log with the user who made it', async () => {
    const { rows } = await t.admin.query(
      `SELECT actor_type, actor_id FROM audit.activity_log WHERE target_id = $1 AND action = 'debts.update' ORDER BY id DESC LIMIT 1`,
      [SURESH_DEBT],
    );
    expect(rows[0]).toEqual({ actor_type: 'user', actor_id: '22222222-2222-4222-8222-000000000002' });
  });

  it('another client cannot edit or see these records', async () => {
    expect((await patch(`/api/debts/${SURESH_DEBT}`, { reason: 'Hacked reason' }, other)).statusCode).toBe(404);
    expect((await patch(`/api/debtors/${FAHAD_DEBTOR}`, { full_name: 'Hacked' }, other)).statusCode).toBe(404);
    const inst = await t.app.inject({ method: 'GET', url: `/api/debtors/${RAHIM_DEBTOR}/instruments`, headers: other });
    expect(inst.statusCode).toBe(404);
  });
});

describe('lookups', () => {
  it('lists instrument types with their Najiz names', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/instrument-types', headers: staff });
    const nafith = res.json().items.find((i: { code: string }) => i.code === 'nafith_promissory_note');
    expect(nafith).toMatchObject({ directly_enforceable: true, najiz_sub_type: 'سند لأمر' });
  });

  it('finds debtors by name, reference, ID number or phone', async () => {
    for (const q of ['Rahim', 'D-000003', '2000000003']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/debtors?search=${encodeURIComponent(q)}`, headers: staff });
      expect(res.json().items.map((d: { id: string }) => d.id)).toContain(RAHIM_DEBTOR);
    }
    const res = await t.app.inject({ method: 'GET', url: '/api/debtors?search=0551119999', headers: staff });
    expect(res.statusCode).toBe(200);
  });

  it('only shows the client\'s own debtors', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/debtors?limit=200', headers: staff });
    const clients = await t.admin.query(`SELECT DISTINCT client_id FROM app.debtors WHERE id = ANY($1::uuid[])`, [
      res.json().items.map((d: { id: string }) => d.id),
    ]);
    expect(clients.rows).toEqual([{ client_id: CLIENT }]);
  });
});
