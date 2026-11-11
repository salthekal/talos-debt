/**
 * Step 5.1: the filing pack PDF. Printed by a real Chromium, so these tests
 * check the real thing: the Arabic page, the amounts as text, the contact
 * history, and every file joined at the end.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { money, packHtml, type PackData } from '../src/legal/pack.js';
import { multipart, other, PNG, staff, startApp, viewer, type TestApp } from './helpers.js';

const IMRAN_DEBT = '66666666-6666-4666-8666-000000000001';
let t: TestApp;

async function onePagePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText(text, { x: 20, y: 100, size: 14 });
  return Buffer.from(await doc.save());
}
async function upload(fields: Record<string, string>, bytes: Buffer, name: string) {
  const body = multipart(fields, { name, bytes });
  const res = await t.app.inject({ method: 'POST', url: '/api/documents', headers: { ...staff, ...body.headers }, payload: body.payload });
  expect(res.statusCode).toBe(201);
}
/** The text of a PDF, as pdftotext reads it (Poppler). */
function textOf(bytes: Buffer): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pack-'));
  const file = path.join(dir, 'pack.pdf');
  writeFileSync(file, bytes);
  return execFileSync('pdftotext', ['-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
}

beforeAll(async () => {
  t = await startApp();
  await t.admin.query(`UPDATE app.debts SET status = 'legal_ready' WHERE id = $1`, [IMRAN_DEBT]);
  await upload({ doc_type: 'cr' }, await onePagePdf('COMMERCIAL REGISTRATION'), 'cr.pdf');
  await upload({ doc_type: 'promissory_note', debt_id: IMRAN_DEBT }, await onePagePdf('PROMISSORY NOTE'), 'note.pdf');
  await upload({ doc_type: 'iqama', debtor_id: '33333333-3333-4333-8333-000000000001' }, PNG, 'iqama.png');
}, 60_000);
afterAll(async () => {
  await t?.close();
});

describe('money on the page', () => {
  it('groups digits from the text the database gives, never as a number', () => {
    expect(money('1234567.5')).toContain('1,234,567.50');
    expect(money('3450.00')).toContain('3,450.00');
    expect(money(null)).toContain('-');
  });
});

describe('the page', () => {
  it('escapes what people typed, so a name cannot add anything to the page', () => {
    const data = {
      detail: {
        row: { ref_code: 'DBT-1', najiz_request_number: null, najiz_status: null },
        company: { legal_name: '<script>x</script>', unified_number: '7000000001', owner_name: 'O', owner_id_type: 'national_id', owner_id_last4: '0100', owner_email: 'a@b.c', owner_phone: '+966500000100', bank_name: 'B', iban: 'SA1' },
        debtor: { full_name: 'A "B" <C>', first_name: null, father_name: null, grandfather_name: null, family_name: null, id_type: 'iqama', id_number: '2000000001', nationality: 'PK', phone: null },
        note: { type: 'nafith_promissory_note', reference_number: null, issue_date: null, due_date: null, due_on_demand: true, issue_city: null, issue_country: null, face_amount: '100.00' },
        amounts: { claimed: '100.00', received: '0.00' }, approval: null,
      },
      client: { cr_number: '4030000000', trade_name: null }, contacts: [], files: [], generatedAt: new Date('2026-11-11T09:00:00Z'),
    } as unknown as PackData;
    const html = packHtml(data, new Map());
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('dir="rtl"');
    expect(html).not.toMatch(/https?:\/\//);
  });
});

describe('making the filing pack (5.1)', () => {
  let docId: string;

  it('prints the case and joins every file, PDFs page by page and photos as pages', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/legal/${IMRAN_DEBT}/pack`, headers: staff });
    expect(res.statusCode).toBe(201);
    const { document, not_attached } = res.json();
    expect(document).toMatchObject({ doc_type: 'legal_pack', mime_type: 'application/pdf', source: 'system_generated', debt_id: IMRAN_DEBT });
    expect(not_attached).toEqual([]);
    docId = document.id;

    const row = await t.admin.query(`SELECT storage_key FROM app.documents WHERE id = $1`, [docId]);
    const bytes = await t.storage.get(row.rows[0].storage_key);
    const pdf = await PDFDocument.load(bytes);
    const pages = pdf.getPageCount();
    // The pack page(s), then the commercial registration, the note and the iqama photo.
    expect(pages).toBeGreaterThanOrEqual(4);
    const text = textOf(bytes);
    expect(text).toContain('DBT-2026-0001');
    expect(text).toContain('3,450.00');
    expect(text).toContain('7000000001');
    expect(text).toContain('COMMERCIAL REGISTRATION');
    expect(text).toContain('PROMISSORY NOTE');
    // The owner's ID number is never printed in full.
    expect(text).not.toContain('1000000100');
    // The contact history: the seed sent Imran reminders.
    expect(text).toMatch(/whatsapp|واتساب/i);
  }, 60_000);

  it('the case page shows the latest pack, and anyone in the client can download it', async () => {
    const c = (await t.app.inject({ method: 'GET', url: `/api/legal/${IMRAN_DEBT}`, headers: viewer })).json();
    expect(c.pack).toMatchObject({ id: docId, doc_type: 'legal_pack' });
    const dl = await t.app.inject({ method: 'GET', url: `/api/documents/${docId}/download`, headers: viewer });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
  });

  it('a file that cannot be read is listed as not attached, and the pack is still made', async () => {
    await upload({ doc_type: 'contract', debt_id: IMRAN_DEBT }, Buffer.from('%PDF-1.4\nnot really a pdf\n%%EOF\n'), 'broken.pdf');
    const res = await t.app.inject({ method: 'POST', url: `/api/legal/${IMRAN_DEBT}/pack`, headers: staff });
    expect(res.statusCode).toBe(201);
    expect(res.json().not_attached).toHaveLength(1);
  }, 60_000);

  it('viewers cannot make a pack; other clients cannot see the debt', async () => {
    expect((await t.app.inject({ method: 'POST', url: `/api/legal/${IMRAN_DEBT}/pack`, headers: viewer })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'POST', url: `/api/legal/${IMRAN_DEBT}/pack`, headers: other })).statusCode).toBe(404);
  });
});
