/**
 * Step 3.4: documents per debtor, debt and instrument.
 * Step 3.5: how much debt is directly enforceable, and paper notes at risk.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAHAD_DEBTOR, multipart, other, PDF, PNG, RAHIM_DEBT, RAHIM_DEBTOR, staff, startApp, viewer, type TestApp } from './helpers.js';

let t: TestApp;
let lawSet: TestApp;

beforeAll(async () => {
  t = await startApp({ MAX_UPLOAD_MB: '1' });
});
afterAll(async () => {
  await t?.close();
  await lawSet?.close();
});

function send(fields: Record<string, string>, file: { name: string; bytes: Buffer } | undefined, headers = staff) {
  const body = multipart(fields, file);
  return t.app.inject({ method: 'POST', url: '/api/documents', headers: { ...headers, ...body.headers }, payload: body.payload });
}

describe('uploading documents', () => {
  let docId: string;

  it('stores a promissory note scan for a debt, linked to its debtor', async () => {
    const res = await send({ doc_type: 'promissory_note', debt_id: RAHIM_DEBT }, { name: 'سند لأمر.pdf', bytes: PDF });
    expect(res.statusCode).toBe(201);
    const doc = res.json().document;
    expect(doc).toMatchObject({
      debtor_id: RAHIM_DEBTOR, debt_id: RAHIM_DEBT, mime_type: 'application/pdf', file_name: 'سند لأمر.pdf',
      size_bytes: String(PDF.length), sha256: createHash('sha256').update(PDF).digest('hex'),
    });
    docId = doc.id;
    // The storage key has no names or ID numbers in it.
    const row = await t.admin.query(`SELECT storage_key FROM app.documents WHERE id = $1`, [docId]);
    expect(row.rows[0].storage_key).toBe(`clients/11111111-1111-4111-8111-111111111111/documents/${docId}`);
  });

  it('downloads the same bytes, as an attachment', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/documents/${docId}/download`, headers: viewer });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PDF)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment;.*filename\*=UTF-8''/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('lists documents of a debtor', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/documents?debtor_id=${RAHIM_DEBTOR}`, headers: staff });
    expect(res.json().items.map((d: { id: string }) => d.id)).toContain(docId);
  });

  it('decides the type from the file, not its name', async () => {
    const res = await send({ doc_type: 'receipt', debtor_id: FAHAD_DEBTOR }, { name: 'receipt.pdf', bytes: Buffer.from('MZ fake program') });
    expect(res.statusCode).toBe(415);
    const png = await send({ doc_type: 'receipt', debtor_id: FAHAD_DEBTOR }, { name: 'receipt.pdf', bytes: PNG });
    expect(png.statusCode).toBe(201);
    expect(png.json().document.mime_type).toBe('image/png');
  });

  it('refuses files over the size limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10)]);
    const res = await send({ doc_type: 'contract', debtor_id: FAHAD_DEBTOR }, { name: 'big.pdf', bytes: big });
    expect(res.statusCode).toBe(413);
  });

  it('refuses a debt and debtor that do not match', async () => {
    const res = await send({ doc_type: 'invoice', debtor_id: FAHAD_DEBTOR, debt_id: RAHIM_DEBT }, { name: 'x.pdf', bytes: PDF });
    expect(res.statusCode).toBe(400);
  });

  it('a debtor document needs a debtor; company papers do not', async () => {
    expect((await send({ doc_type: 'iqama' }, { name: 'x.pdf', bytes: PDF })).statusCode).toBe(400);
    const cr = await send({ doc_type: 'cr' }, { name: 'cr.pdf', bytes: PDF });
    expect(cr.statusCode).toBe(201);
    const list = await t.app.inject({ method: 'GET', url: '/api/documents?scope=client', headers: staff });
    expect(list.json().items.map((d: { doc_type: string }) => d.doc_type)).toContain('cr');
  });

  it('a viewer cannot upload', async () => {
    expect((await send({ doc_type: 'other', debtor_id: FAHAD_DEBTOR }, { name: 'x.pdf', bytes: PDF }, viewer)).statusCode).toBe(403);
  });

  it('another client cannot upload to, list or download these', async () => {
    expect((await send({ doc_type: 'contract', debt_id: RAHIM_DEBT }, { name: 'x.pdf', bytes: PDF }, other)).statusCode).toBe(404);
    const list = await t.app.inject({ method: 'GET', url: `/api/documents?debtor_id=${RAHIM_DEBTOR}`, headers: other });
    expect(list.json().items).toEqual([]);
    const dl = await t.app.inject({ method: 'GET', url: `/api/documents/${docId}/download`, headers: other });
    expect(dl.statusCode).toBe(404);
  });

  it('uploads are in the audit log', async () => {
    const { rows } = await t.admin.query(`SELECT action FROM audit.activity_log WHERE target_id = $1`, [docId]);
    expect(rows[0]?.action).toBe('documents.insert');
  });
});

describe('enforceability (3.5)', () => {
  it('splits the open debt by instrument and flags the paper note, with no deadline yet', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/enforceability', headers: staff });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.law_start_date).toBeNull();
    expect(body.paper_note_deadline).toBeNull();
    // Seed: Nafith note (Imran), paper note (Rahim), cheque (Suresh); Fahad and Ahmed have none.
    const types = body.by_type.map((x: { type_code: string }) => x.type_code);
    expect(types).toEqual(expect.arrayContaining(['nafith_promissory_note', 'paper_promissory_note', 'cheque', 'none']));
    const rahim = body.paper_notes_at_risk.items.find((x: { debt_id: string }) => x.debt_id === RAHIM_DEBT);
    expect(rahim).toMatchObject({ type_code: 'paper_promissory_note', deadline: null, days_left: null });
    expect(body.paper_notes_at_risk.note).toMatch(/not published yet/);
    expect(body.without_instrument.debts).toBe(2);
    const sum = (k: string) => Number(body.totals[k]);
    expect(sum('enforceable') + sum('needs_court_case')).toBeCloseTo(sum('open_balance'), 2);
    expect(body.totals.enforceable_share_pct).toBeGreaterThan(0);
  });

  it('gives a deadline one year after the law starts', async () => {
    lawSet = await startApp({ ENFORCEMENT_LAW_START_DATE: '2027-01-01' });
    const res = await lawSet.app.inject({ method: 'GET', url: '/api/enforceability', headers: staff });
    const body = res.json();
    expect(body.paper_note_deadline).toBe('2028-01-01');
    const rahim = body.paper_notes_at_risk.items.find((x: { debt_id: string }) => x.debt_id === RAHIM_DEBT);
    expect(rahim.deadline).toBe('2028-01-01');
    expect(typeof rahim.days_left).toBe('number');
  });

  it('a deadline set on the note itself wins over the general one', async () => {
    const note = await lawSet.admin.query(`SELECT instrument_id FROM app.debts WHERE id = $1`, [RAHIM_DEBT]);
    const set = await lawSet.app.inject({
      method: 'PATCH', url: `/api/instruments/${note.rows[0].instrument_id}`, headers: staff,
      payload: { enforceable_until: '15/06/2027', verified: true },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().instrument.verified_by).toBeTruthy();
    const res = await lawSet.app.inject({ method: 'GET', url: '/api/enforceability', headers: staff });
    const rahim = res.json().paper_notes_at_risk.items.find((x: { debt_id: string }) => x.debt_id === RAHIM_DEBT);
    expect(rahim.deadline).toBe('2027-06-15');
    const bad = await lawSet.app.inject({
      method: 'PATCH', url: `/api/instruments/${note.rows[0].instrument_id}`, headers: staff, payload: { enforceable_until: 'soon' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('only counts the client\'s own debts', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/enforceability', headers: other });
    expect(res.json().totals.open_debts).toBe('0');
  });
});
