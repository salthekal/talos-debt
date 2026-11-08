/**
 * Step 3.1: Excel import. One row per debt; rows with the same ID number are
 * one debtor; rows with the same instrument and number share it. Nothing is
 * saved until the import is confirmed, and then everything is saved together.
 */
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLUMNS } from '../src/import/columns.js';
import { fakeId, multipart, other, PDF, RAHIM_DEBTOR, staff, startApp, viewer, type TestApp } from './helpers.js';

let t: TestApp;
let template: Buffer;

beforeAll(async () => {
  t = await startApp();
  const res = await t.app.inject({ method: 'GET', url: '/api/imports/template', headers: staff });
  template = res.rawPayload;
});
afterAll(async () => {
  await t?.close();
});

type Row = Partial<Record<string, ExcelJS.CellValue>>;

/** Fill the downloaded template like a client would. */
async function fillTemplate(rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(template as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('Debts')!;
  rows.forEach((r, i) => {
    for (const [key, v] of Object.entries(r)) {
      const col = COLUMNS.findIndex((c) => c.key === key) + 1;
      ws.getRow(i + 2).getCell(col).value = v ?? null;
    }
  });
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** A workbook of our own, not from the template. */
async function workbook(headers: string[], rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const upload = (bytes: Buffer, headers = staff, name = 'debts.xlsx') => {
  const body = multipart({}, { name, bytes });
  return t.app.inject({ method: 'POST', url: '/api/imports', headers: { ...headers, ...body.headers }, payload: body.payload });
};
const confirm = (id: string, headers = staff) => t.app.inject({ method: 'POST', url: `/api/imports/${id}/confirm`, headers });
const count = async (sql: string, params: unknown[] = []) => Number((await t.admin.query(sql, params)).rows[0].count);

const A = fakeId('2', 5001);
const B = fakeId('1', 5002);
const NAFITH = 'Promissory note on Nafith / سند لأمر إلكتروني (نافذ)';

describe('the template', () => {
  it('has the columns, dropdowns, help notes and an instructions sheet', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Debts')!;
    expect(ws.getRow(1).getCell(2).value).toBe('ID number *\nرقم الهوية');
    expect(ws.getRow(1).getCell(2).note).toBeTruthy();
    expect(wb.getWorksheet('Lists')!.state).toBe('hidden');
    expect(wb.getWorksheet('Instructions')).toBeTruthy();
    const instrumentCol = COLUMNS.findIndex((c) => c.key === 'instrument_type') + 1;
    const v = ws.getRow(10).getCell(instrumentCol).dataValidation;
    expect(v?.type).toBe('list');
    // Phone and ID columns are text, so Excel keeps the leading 0.
    expect(ws.getColumn(COLUMNS.findIndex((c) => c.key === 'phone_1') + 1).numFmt).toBe('@');
  });

  it('a viewer can download it', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/imports/template', headers: viewer });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
  });
});

describe('a good file', () => {
  let importId: string;

  it('is checked and summarised, but nothing is saved yet', async () => {
    const before = await count(`SELECT count(*) FROM app.debts`);
    const file = await fillTemplate([
      // Debtor A: two debts on one Nafith note, phones spread over the rows.
      { id_number: A, full_name: 'Import Courier A', phone_1: '0561230001', preferred_language: 'Urdu / الأردية',
        amount: 1500, reason: 'Motorcycle rent, August 2026', reason_category: 'Vehicle rent / إيجار مركبة',
        issue_date: new Date(Date.UTC(2026, 7, 1)), instrument_type: NAFITH, instrument_reference: 'NF-77001' },
      { id_number: A, full_name: 'import courier a', phone_1: '0561230001', phone_2: '+923001230001',
        amount: '640.50', reason: 'Cash on delivery not handed over', instrument_type: NAFITH, instrument_reference: 'nf-77 001',
        instrument_issue_date: '01/03/2026' },
      // Debtor B: phone typed as a number (leading 0 lost), amount with a comma, Arabic labels, a cheque.
      { id_type: 'هوية وطنية', id_number: B, full_name: 'Import Customer B', full_name_ar: 'عميل تجريبي',
        phone_1: 561230002, amount: '1,250.50', reason: 'Unpaid invoice INV-88', reason_category: 'فاتورة غير مدفوعة',
        debt_ref: 'INV-88', due_date: '30/09/2026', instrument_type: 'Cheque / شيك', instrument_reference: '000123' },
      // Rahim is already in the system: details kept, new debt added on his existing paper note.
      { id_number: '2000000003', id_type: 'Iqama', full_name: 'Rahim U.', phone_1: '0561230003', amount: 300,
        reason: 'Helmet not returned', instrument_type: 'paper_promissory_note', instrument_reference: 'PAPER-DEMO-0003' },
    ]);
    const res = await upload(file);
    expect(res.statusCode).toBe(201);
    const imp = res.json().import;
    expect(imp.errors).toEqual([]);
    expect(imp.status).toBe('ready');
    expect(imp.summary).toMatchObject({
      rows: 4, rows_with_errors: 0, debtors_new: 2, debtors_existing: 1, debts: 4,
      total_amount: '3691.00', enforceable_amount: '3691.00', instruments_new: 2, instruments_reused: 1, phones_new: 4,
    });
    // Rahim's different name is a warning, not an error.
    expect(imp.warnings.some((w: { cell: string; message: string }) => w.cell === 'C5' && /Already in the system as D-000003/.test(w.message))).toBe(true);
    expect(await count(`SELECT count(*) FROM app.debts`)).toBe(before);
    importId = imp.id;
  });

  it('is saved completely on confirm', async () => {
    const res = await confirm(importId);
    expect(res.statusCode).toBe(200);
    expect(res.json().import.status).toBe('imported');

    const a = await t.admin.query(
      `SELECT d.id, d.ref_code, d.preferred_language,
              (SELECT array_agg(phone_e164 ORDER BY is_primary DESC, phone_e164) FROM app.debtor_phones p WHERE p.debtor_id = d.id) AS phones,
              (SELECT count(DISTINCT instrument_id) FROM app.debts x WHERE x.debtor_id = d.id) AS instruments,
              (SELECT count(*) FROM app.debts x WHERE x.debtor_id = d.id AND x.import_id = $2) AS debts
         FROM app.debtors d WHERE d.id_number = $1`,
      [A, importId],
    );
    expect(a.rows[0]).toMatchObject({
      preferred_language: 'ur', phones: ['+966561230001', '+923001230001'], instruments: '1', debts: '2',
    });
    expect(a.rows[0].ref_code).toMatch(/^D-\d{6}$/);
    const note = await t.admin.query(
      `SELECT i.issue_date::text FROM app.instruments i JOIN app.debts x ON x.instrument_id = i.id WHERE x.debtor_id = $1 LIMIT 1`,
      [a.rows[0].id],
    );
    expect(note.rows[0].issue_date).toBe('2026-03-01'); // taken from the second row

    const b = await t.admin.query(
      `SELECT x.ref_code, x.amount_original::text, x.reason_category, x.due_date::text, d.id_type,
              (SELECT phone_e164 FROM app.debtor_phones p WHERE p.debtor_id = d.id) AS phone
         FROM app.debts x JOIN app.debtors d ON d.id = x.debtor_id WHERE d.id_number = $1`,
      [B],
    );
    expect(b.rows[0]).toEqual({
      ref_code: 'INV-88', amount_original: '1250.50', reason_category: 'invoice', due_date: '2026-09-30', id_type: 'national_id',
      phone: '+966561230002',
    });

    const rahim = await t.admin.query(
      `SELECT full_name,
              (SELECT count(*) FROM app.instruments WHERE debtor_id = $1) AS instruments,
              (SELECT is_primary FROM app.debtor_phones WHERE debtor_id = $1 AND phone_e164 = '+966561230003') AS new_phone_primary
         FROM app.debtors WHERE id = $1`,
      [RAHIM_DEBTOR],
    );
    expect(rahim.rows[0]).toEqual({ full_name: 'Rahim Uddin Demo', instruments: '1', new_phone_primary: false });

    const stored = await t.admin.query(`SELECT rows, confirmed_by FROM app.imports WHERE id = $1`, [importId]);
    expect(stored.rows[0].rows).toBeNull(); // parsed rows are not kept after import
    expect(stored.rows[0].confirmed_by).toBeTruthy();
  });

  it('cannot be confirmed twice', async () => {
    const res = await confirm(importId);
    expect(res.statusCode).toBe(409);
  });
});

describe('a file with mistakes', () => {
  it('lists every problem with its cell, and saves nothing', async () => {
    const before = await count(`SELECT count(*) FROM app.debtors`);
    const C = fakeId('2', 5003);
    const file = await fillTemplate([
      { id_number: C, full_name: 'Mistake Courier', phone_1: '12345', amount: 100, reason: 'Bad phone' }, // row 2
      { id_number: C, full_name: 'Someone Else', phone_1: '0561230004', reason: 'Missing amount' }, // row 3
      { id_number: fakeId('2', 5004), full_name: 'Dup Ref', phone_1: '0561230005', amount: 50, reason: 'First', debt_ref: 'R-1' }, // row 4
      { id_number: fakeId('2', 5005), full_name: 'Dup Ref Two', phone_1: '0561230006', amount: 50, reason: 'Second', debt_ref: 'R-1' }, // row 5
      { id_number: fakeId('2', 5006), full_name: 'Used Ref', phone_1: '0561230007', amount: 50, reason: 'Third', debt_ref: 'DBT-2026-0001' }, // row 6
      { id_number: fakeId('2', 5007), full_name: 'Hijri Date', phone_1: '0561230008', amount: 50, reason: 'Fourth', issue_date: '01/03/1447' }, // row 7
      { id_number: fakeId('2', 5008), full_name: 'Odd Note', phone_1: '0561230009', amount: 50, reason: 'Fifth', instrument_type: 'IOU on a napkin' }, // row 8
      { id_number: '3000000000', full_name: 'Bad ID', phone_1: '0561230010', amount: 50, reason: 'Sixth' }, // row 9
    ]);
    const res = await upload(file);
    expect(res.statusCode).toBe(201);
    const imp = res.json().import;
    expect(imp.status).toBe('failed');
    const cells = imp.errors.map((e: { cell: string }) => e.cell);
    // Columns: B ID number, C name, E phone 1, M debt ref, N amount, Q debt date, S instrument; row 9 has no ID type.
    expect(cells).toEqual(expect.arrayContaining(['E2', 'N3', 'C3', 'M5', 'M6', 'Q7', 'S8', 'A9']));
    expect(imp.errors.find((e: { cell: string }) => e.cell === 'C3').message).toMatch(/different name/);
    expect(imp.errors.find((e: { cell: string }) => e.cell === 'Q7').message).toMatch(/Hijri/);
    expect(imp.rows_failed).toBe(7);
    expect(await count(`SELECT count(*) FROM app.debtors`)).toBe(before);
    expect((await confirm(imp.id)).statusCode).toBe(409);
  });

  it('a file without the required columns is refused with one clear message', async () => {
    const res = await upload(await workbook(['Name', 'Mobile'], [['X', '0500000000']]));
    expect(res.json().import.status).toBe('failed');
    // "Name" and "Mobile" are not template headers, so every required column is missing.
    expect(res.json().import.errors[0].message).toMatch(
      /Required columns are missing: "ID number", "Full name", "Phone 1", "Amount \(SAR\)", "Reason"/,
    );
  });

  it('refuses files that are not Excel workbooks', async () => {
    expect((await upload(PDF, staff, 'debts.xlsx')).statusCode).toBe(415);
    expect((await upload(Buffer.from('id,name\n1,x\n'), staff, 'debts.csv')).statusCode).toBe(415);
    // A zip that is not a workbook.
    expect((await upload(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), staff)).statusCode).toBe(415);
  });

  it('refuses Excel files over 5 MB', async () => {
    const big = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(5 * 1024 * 1024 + 10)]);
    expect((await upload(big)).statusCode).toBe(413);
  });
});

describe('other layouts', () => {
  it('accepts Arabic headers in any order', async () => {
    const D = fakeId('2', 5010);
    const file = await workbook(
      ['سبب الدين', 'المبلغ (ريال)', 'الجوال 1', 'الاسم الكامل', 'رقم الهوية', 'عمود إضافي'],
      [['سلفة راتب', '١٢٠٠', '٠٥٦١٢٣٠٠١١', 'مدين عربي', D, 'ignored']],
    );
    const res = await upload(file);
    const imp = res.json().import;
    expect(imp.status).toBe('ready');
    expect(imp.summary).toMatchObject({ debts: 1, total_amount: '1200.00' });
    expect(imp.warnings[0].message).toMatch(/not a template column/);
    expect((await confirm(imp.id)).statusCode).toBe(200);
  });
});

describe('safety', () => {
  it('checks again on confirm: a reference taken since the upload stops the whole import', async () => {
    const E = fakeId('2', 5020);
    const file = await fillTemplate([
      { id_number: E, full_name: 'Race One', phone_1: '0561230020', amount: 10, reason: 'First debt', debt_ref: 'RACE-1' },
      { id_number: E, full_name: 'Race One', phone_1: '0561230020', amount: 20, reason: 'Second debt' },
    ]);
    const imp = (await upload(file)).json().import;
    expect(imp.status).toBe('ready');
    // Someone adds a debt with the same reference before the import is confirmed.
    await t.app.inject({
      method: 'POST', url: `/api/debtors/${RAHIM_DEBTOR}/debts`, headers: staff,
      payload: { ref_code: 'RACE-1', amount: 5, reason: 'Added by hand meanwhile' },
    });
    const res = await confirm(imp.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().import.status).toBe('failed');
    expect(await count(`SELECT count(*) FROM app.debtors WHERE id_number = $1`, [E])).toBe(0);
  });

  it('another client cannot see or confirm the import', async () => {
    const file = await fillTemplate([{ id_number: fakeId('2', 5030), full_name: 'Private', phone_1: '0561230030', amount: 10, reason: 'Private debt' }]);
    const imp = (await upload(file)).json().import;
    expect((await t.app.inject({ method: 'GET', url: `/api/imports/${imp.id}`, headers: other })).statusCode).toBe(404);
    expect((await confirm(imp.id, other)).statusCode).toBe(404);
    const list = await t.app.inject({ method: 'GET', url: '/api/imports', headers: other });
    expect(list.json().items).toEqual([]);
  });

  it('a viewer cannot upload or confirm', async () => {
    const file = await fillTemplate([{ id_number: fakeId('2', 5040), full_name: 'Viewer', phone_1: '0561230040', amount: 10, reason: 'Viewer try' }]);
    expect((await upload(file, viewer)).statusCode).toBe(403);
  });

  it('cancel drops the stored rows', async () => {
    const file = await fillTemplate([{ id_number: fakeId('2', 5050), full_name: 'Cancel Me', phone_1: '0561230050', amount: 10, reason: 'To cancel' }]);
    const imp = (await upload(file)).json().import;
    const res = await t.app.inject({ method: 'POST', url: `/api/imports/${imp.id}/cancel`, headers: staff });
    expect(res.statusCode).toBe(200);
    const stored = await t.admin.query(`SELECT status, rows FROM app.imports WHERE id = $1`, [imp.id]);
    expect(stored.rows[0]).toEqual({ status: 'cancelled', rows: null });
    expect((await confirm(imp.id)).statusCode).toBe(409);
  });
});

describe('size', () => {
  it('imports 2,000 rows (1,000 debtors with 2 debts each) in one go', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = fakeId('2', 600000 + i);
      const phone = `05${String(70000000 + i)}`;
      rows.push({ id_number: id, full_name: `Bulk Courier ${i}`, phone_1: phone, amount: 100 + i, reason: 'Bulk rent',
        instrument_type: NAFITH, instrument_reference: `BULK-${i}` });
      rows.push({ id_number: id, full_name: `Bulk Courier ${i}`, phone_1: phone, amount: 50, reason: 'Bulk damages',
        instrument_type: NAFITH, instrument_reference: `BULK-${i}` });
    }
    const started = Date.now();
    const imp = (await upload(await fillTemplate(rows))).json().import;
    expect(imp.status).toBe('ready');
    expect(imp.summary).toMatchObject({ debtors_new: 1000, debts: 2000, instruments_new: 1000 });
    const res = await confirm(imp.id);
    expect(res.statusCode).toBe(200);
    expect(await count(`SELECT count(*) FROM app.debts WHERE import_id = $1`, [imp.id])).toBe(2000);
    expect(Date.now() - started).toBeLessThan(30000);
  }, 60000);
});
