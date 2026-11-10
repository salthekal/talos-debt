/**
 * The filing pack (5.1): one PDF for a legal case, for the client's records and
 * as proof if Najiz or the court asks. Arabic first, with English labels.
 *
 *   1. The request as it goes to Najiz: type, requester, debtor, note, amounts
 *   2. Every contact with the debtor (messages, promises, payments, disputes),
 *      as proof that the debt was followed up before going to court
 *   3. The list of attached files with their fingerprints (SHA-256)
 *   4. The files themselves: PDFs page by page, photos as pages
 *
 * The page is printed by Chromium (pdf.ts); the files are joined with pdf-lib.
 * Money stays text from the database to the page.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import type { Db } from '../db.js';
import type { FileStorage } from '../storage/storage.js';
import { loadDetail, type LegalCaseDetail } from './case.js';

const require = createRequire(import.meta.url);
const font = (file: string) =>
  readFileSync(require.resolve(`@fontsource/ibm-plex-sans-arabic/files/${file}`)).toString('base64');
let fonts: string | null = null;
function fontFaces(): string {
  fonts ??= [
    ['arabic-400', 400], ['arabic-600', 600], ['latin-400', 400], ['latin-600', 600],
  ].map(([f, w]) => `@font-face{font-family:'Plex Arabic';font-weight:${w};src:url(data:font/woff2;base64,${font(`ibm-plex-sans-arabic-${f}-normal.woff2`)}) format('woff2')}`)
    .join('');
  return fonts;
}

export interface PackFile {
  id: string;
  doc_type: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  storage_key: string;
  created_at: string;
}

export interface PackContact {
  kind: 'message' | 'promise' | 'payment' | 'dispute';
  at: string;
  direction: string | null;
  channel: string | null;
  status: string;
  text: string | null;
  amount: string | null;
}

export interface PackData {
  detail: LegalCaseDetail;
  client: { cr_number: string; trade_name: string | null };
  contacts: PackContact[];
  files: PackFile[];
  generatedAt: Date;
}

/** Everything the pack shows, read inside the client's transaction (RLS applies). */
export async function loadPackData(db: Db, debtId: string, now = new Date()): Promise<PackData | undefined> {
  const detail = await loadDetail(db, debtId);
  if (!detail) return undefined;
  const client = (await db.query(`SELECT cr_number, trade_name FROM app.clients WHERE id = app.current_client_id()`)).rows[0];
  const contacts = (
    await db.query<PackContact>(
      `SELECT * FROM (
         SELECT 'message' AS kind, coalesce(m.sent_at, m.created_at) AS at, m.direction, m.channel, m.status, m.body AS text, NULL::text AS amount
           FROM app.messages m WHERE m.debt_id = $1
         UNION ALL
         SELECT 'promise', p.created_at, NULL, NULL, p.status,
                'Promised to pay by ' || p.promised_date::text, p.promised_amount::text
           FROM app.promises p WHERE p.debt_id = $1
         UNION ALL
         SELECT 'payment', coalesce(p.paid_at, p.created_at), NULL, p.method, p.status, p.rejection_reason, p.amount::text
           FROM app.payments p WHERE p.debt_id = $1
         UNION ALL
         SELECT 'dispute', d.created_at, NULL, NULL, d.status, d.reason, NULL
           FROM app.disputes d WHERE d.debt_id = $1
       ) x ORDER BY at, kind`,
      [debtId],
    )
  ).rows;
  // The company's papers, then every document of this debt, its note and its debtor. Never an earlier pack.
  const files = (
    await db.query<PackFile>(
      `SELECT d.id, d.doc_type, d.file_name, d.mime_type, d.size_bytes::text, d.sha256, d.storage_key, d.created_at
         FROM app.documents d
         JOIN app.debts x ON x.id = $1
        WHERE d.doc_type NOT IN ('legal_pack', 'import_file')
          AND ((d.debtor_id IS NULL AND d.doc_type IN ('cr', 'establishment_contract', 'partners_decision'))
               OR d.debt_id = x.id
               OR (x.instrument_id IS NOT NULL AND d.instrument_id = x.instrument_id)
               OR (d.debtor_id = x.debtor_id AND d.debt_id IS NULL AND d.instrument_id IS NULL))
        ORDER BY CASE d.doc_type WHEN 'cr' THEN 0 WHEN 'establishment_contract' THEN 1 WHEN 'partners_decision' THEN 2
                                 WHEN 'promissory_note' THEN 3 ELSE 4 END, d.created_at`,
      [debtId],
    )
  ).rows;
  return { detail, client, contacts, files, generatedAt: now };
}

// ------------------------------------------------------------------ the page

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const ltr = (v: unknown) => `<bdi dir="ltr">${esc(v)}</bdi>`;
const dash = '<span class="none">-</span>';

/** 12345.5 as "12,345.50 ر.س", from the text the database gives. */
export function money(amount: string | null | undefined): string {
  if (amount == null) return dash;
  const [whole = '0', frac = '00'] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${ltr(`${grouped}.${frac.padEnd(2, '0').slice(0, 2)}`)} ر.س`;
}

const riyadh = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dayOnly = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
const when = (v: string | Date | null | undefined, withTime = true) => {
  if (!v) return dash;
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : new Date(v);
  return ltr((withTime ? riyadh : dayOnly).format(d).replace(',', ''));
};

const ID_TYPE: Record<string, string> = { national_id: 'هوية وطنية', iqama: 'هوية مقيم', passport: 'جواز سفر', cr: 'سجل تجاري' };
const NOTE_TYPE: Record<string, string> = { nafith_promissory_note: 'سند لأمر (نافذ)', paper_promissory_note: 'سند لأمر (ورقي)' };
const DOC: Record<string, string> = {
  cr: 'السجل التجاري', establishment_contract: 'عقد التأسيس', partners_decision: 'قرارات الشركاء', promissory_note: 'السند لأمر',
  national_id: 'الهوية الوطنية', iqama: 'الإقامة', employment_contract: 'عقد العمل', cheque: 'شيك', judgment: 'حكم',
  contract: 'عقد', invoice: 'فاتورة', receipt: 'إيصال', payment_proof: 'إثبات سداد', iban_letter: 'خطاب الآيبان',
  authorization: 'التفويض', najiz_receipt: 'تأكيد ناجز', other: 'مستند آخر',
};
const KIND: Record<PackContact['kind'], string> = { message: 'رسالة', promise: 'وعد بالسداد', payment: 'دفعة', dispute: 'اعتراض' };
const STATUS: Record<string, string> = {
  queued: 'بالانتظار', sent: 'أُرسلت', delivered: 'وصلت', read: 'قُرئت', failed: 'لم تُرسل', received: 'وردت',
  pending: 'قائم', kept: 'وُفي به', partly_kept: 'وُفي به جزئياً', broken: 'لم يُوفَ به', cancelled: 'أُلغي',
  pending_approval: 'بانتظار المراجعة', approved: 'معتمدة', rejected: 'مرفوضة',
  open: 'مفتوح', resolved_valid: 'قُبل', resolved_invalid: 'رُفض',
};
const CHANNEL: Record<string, string> = {
  whatsapp: 'واتساب', sms: 'رسالة نصية', voice: 'اتصال', email: 'بريد',
  bank_transfer: 'تحويل بنكي', cash: 'نقداً', salary_deduction: 'خصم من الراتب', payment_link: 'رابط دفع', other: 'أخرى',
};

const row = (ar: string, en: string, value: string) =>
  `<tr><th><span class="ar">${ar}</span><span class="en">${en}</span></th><td>${value}</td></tr>`;

export function packHtml(p: PackData, included: Map<string, boolean>): string {
  const { detail: c } = p;
  const names = [c.debtor.first_name, c.debtor.father_name, c.debtor.grandfather_name, c.debtor.family_name].filter(Boolean).join(' ');
  const contactRows = p.contacts.length
    ? p.contacts.map((x) => `<tr>
        <td class="nowrap">${when(x.at)}</td>
        <td>${KIND[x.kind]}${x.direction ? ` <span class="muted">(${x.direction === 'inbound' ? 'من المدين' : 'إلى المدين'})</span>` : ''}</td>
        <td>${esc(CHANNEL[x.channel ?? ''] ?? x.channel ?? '')}</td>
        <td>${esc(STATUS[x.status] ?? x.status)}</td>
        <td class="text" dir="auto">${x.amount ? `${money(x.amount)} ` : ''}${esc(x.text ?? '')}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" class="muted">لا يوجد تواصل مسجل لهذه المديونية.</td></tr>`;
  const fileRows = p.files.length
    ? p.files.map((f, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(DOC[f.doc_type] ?? f.doc_type)}</td>
        <td dir="auto">${esc(f.file_name)}</td>
        <td>${when(f.created_at, false)}</td>
        <td>${included.get(f.id) ? 'مرفق في هذا الملف' : '<span class="warn">غير مرفق: افتحه من لوحة التحكم</span>'}</td>
        <td class="hash">${ltr(f.sha256)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="muted">لا توجد مستندات.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(c.row.ref_code)}</title>
<style>
${fontFaces()}
@page { size: A4; margin: 16mm 14mm 18mm; }
* { box-sizing: border-box; }
body { font-family: 'Plex Arabic', sans-serif; color: #121b33; font-size: 10.5pt; line-height: 1.55; margin: 0; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.5px solid #121b33; padding-bottom: 8px; margin-bottom: 14px; }
h1 { font-size: 18pt; margin: 0; font-weight: 600; }
h1 small { display: block; font-size: 10pt; color: #47516b; font-weight: 400; }
.meta { text-align: left; font-size: 9pt; color: #47516b; }
h2 { font-size: 12pt; font-weight: 600; margin: 18px 0 6px; padding: 4px 10px; background: #f3e3f8; color: #6d2683; border-radius: 4px; }
h2 .en { font-weight: 400; font-size: 9pt; margin-inline-start: 6px; }
h2 { break-inside: avoid; break-after: avoid; }
.facts { break-inside: avoid; }
.facts th, .facts td { padding-block: 4px; }
.list thead { display: table-header-group; }
table { width: 100%; border-collapse: collapse; }
.facts th { width: 34%; text-align: start; vertical-align: top; font-weight: 600; padding: 5px 8px; border-bottom: 1px solid #e2e6ee; }
.facts td { padding: 5px 8px; border-bottom: 1px solid #e2e6ee; }
.ar { display: block; }
.en { display: block; font-size: 8pt; color: #646d84; font-weight: 400; }
.list { font-size: 8.8pt; }
.list th { background: #121b33; color: #fff; font-weight: 600; text-align: start; padding: 5px 6px; }
.list td { padding: 5px 6px; border-bottom: 1px solid #e2e6ee; vertical-align: top; }
.list tr { break-inside: avoid; }
.text { white-space: pre-wrap; }
.nowrap { white-space: nowrap; }
.muted, .none { color: #646d84; }
.warn { color: #8a5a00; }
.hash { font-family: monospace; font-size: 6.5pt; word-break: break-all; width: 26%; }
.total td, .total th { font-weight: 600; font-size: 11pt; }
.note { font-size: 8.5pt; color: #47516b; margin-top: 4px; }
footer { margin-top: 22px; font-size: 8pt; color: #646d84; border-top: 1px solid #e2e6ee; padding-top: 6px; }
</style></head><body>
<header>
  <h1>ملف طلب التنفيذ<small>Execution request file</small></h1>
  <div class="meta">
    <div>${ltr(c.row.ref_code)}</div>
    <div>${esc(c.company.legal_name)}</div>
    <div>أُعدّ في ${when(p.generatedAt)}</div>
  </div>
</header>

<h2>نوع الطلب<span class="en">Request type</span></h2>
<table class="facts">
${row('نوع الخدمة', 'Service', 'تقديم طلب تنفيذ إلكتروني')}
${row('التصنيف', 'Category', 'تنفيذ مالي')}
${row('نوع السند الرئيسي', 'Main type', 'أوراق تجارية')}
${row('نوع السند الفرعي', 'Sub type', 'سند لأمر')}
${row('صفة مقدم الطلب', 'Requester capacity', 'بالنيابة عن جهة اعتبارية')}
${row('المحكمة المختصة', 'Court', 'محكمة التنفيذ')}
${row('رقم الطلب في ناجز', 'Najiz request number', c.row.najiz_request_number ? ltr(c.row.najiz_request_number) : '<span class="muted">لم يُقدَّم بعد</span>')}
${c.row.najiz_status ? row('الحالة في ناجز', 'Status on Najiz', esc(c.row.najiz_status)) : ''}
</table>

<h2>طالب التنفيذ<span class="en">Requester</span></h2>
<table class="facts">
${row('الشركة', 'Company', esc(c.company.legal_name))}
${row('الرقم الموحد', 'Unified number', c.company.unified_number ? ltr(c.company.unified_number) : dash)}
${row('السجل التجاري', 'Commercial registration', ltr(p.client.cr_number))}
${row('نوع النيابة', 'Representation', 'ممثل نظامي')}
${row('الممثل', 'Representative', `${esc(c.company.owner_name)} <span class="muted">(${esc(ID_TYPE[c.company.owner_id_type ?? ''] ?? '')} ${ltr(`•••• ${c.company.owner_id_last4 ?? ''}`)})</span>`)}
${row('البريد والجوال', 'Email and mobile', c.approval ? `${ltr(c.approval.contact_email)} · ${ltr(c.approval.contact_phone)}` : `${ltr(c.company.owner_email)} · ${ltr(c.company.owner_phone)}`)}
${row('البنك والآيبان', 'Bank and IBAN', c.company.iban ? `${esc(c.company.bank_name)} · ${ltr(c.company.iban)}` : dash)}
</table>

<h2>المنفذ ضده<span class="en">Debtor</span></h2>
<table class="facts">
${row('الاسم كما في الهوية', 'Name as on the ID', names ? `<span dir="auto">${esc(names)}</span>` : dash)}
${names && names !== c.debtor.full_name ? row('الاسم في السجلات', 'Name in records', `<span dir="auto">${esc(c.debtor.full_name)}</span>`) : ''}
${row('نوع الهوية ورقمها', 'ID', `${esc(ID_TYPE[c.debtor.id_type] ?? c.debtor.id_type)} ${ltr(c.debtor.id_number)}`)}
${row('الجنسية', 'Nationality', ltr(c.debtor.nationality ?? '-'))}
${row('الجوال', 'Mobile', c.debtor.phone ? ltr(c.debtor.phone) : dash)}
</table>

<h2>السند والمبلغ<span class="en">The note and the amount</span></h2>
<table class="facts">
${row('نوع السند', 'Note type', esc(NOTE_TYPE[c.note.type] ?? c.note.type))}
${row('رقم السند', 'Note number', c.note.reference_number ? ltr(c.note.reference_number) : dash)}
${row('تاريخ التحرير', 'Written on', when(c.note.issue_date, false))}
${row('مكان التحرير والوفاء', 'Written and payable in', c.note.issue_city ? `${esc(c.note.issue_city)}، ${esc(c.note.issue_country === 'SA' ? 'السعودية' : c.note.issue_country ?? '')}` : dash)}
${row('الاستحقاق', 'Due', c.note.due_on_demand ? 'لدى الاطلاع / تحت الطلب' : when(c.note.due_date, false))}
${row('المبلغ المدوّن في السند', 'Amount in the note', money(c.note.face_amount))}
${row('المبلغ المستلم', 'Already received', money(c.amounts.received))}
<tr class="total">${`<th><span class="ar">المبلغ المطالب بتنفيذه</span><span class="en">Amount claimed</span></th><td>${money(c.amounts.claimed)}</td>`}</tr>
</table>
${c.approval ? `<p class="note">اعتمد التقديم ${esc(c.approval.approved_by_name)} في ${when(c.approval.approved_at)}، مع الإقرار بصحة جميع البيانات والمرفقات.</p>` : '<p class="note warn">لم يُعتمد التقديم بعد.</p>'}

<h2>سجل التواصل مع المدين<span class="en">Contact history, as proof of follow-up</span></h2>
<table class="list">
<thead><tr><th>التاريخ (الرياض)</th><th>النوع</th><th>القناة</th><th>الحالة</th><th>المحتوى</th></tr></thead>
<tbody>${contactRows}</tbody>
</table>

<h2>المرفقات<span class="en">Attached files</span></h2>
<table class="list">
<thead><tr><th>#</th><th>المستند</th><th>اسم الملف</th><th>تاريخ الرفع</th><th>في هذا الملف</th><th>البصمة (SHA-256)</th></tr></thead>
<tbody>${fileRows}</tbody>
</table>
<p class="note">البصمة تثبت أن الملف لم يتغير منذ رفعه: أي تعديل عليه يغيّر البصمة.</p>

<footer>أعدّته منصة Talos لمتابعة المديونيات من سجلات ${esc(c.company.legal_name)}. Prepared by Talos Debt Follow-up from the client's records.</footer>
</body></html>`;
}

// ------------------------------------------------------------------ joining

/**
 * The pack page, then every file. PDFs are copied page by page; JPEG and PNG
 * photos become one page each. Anything else (or a file that cannot be read,
 * for example a locked PDF) is listed in the pack as "not attached".
 */
export async function buildPack(
  p: PackData,
  storage: FileStorage,
  render: (html: string) => Promise<Buffer>,
): Promise<{ bytes: Buffer; included: Map<string, boolean> }> {
  const loaded: { file: PackFile; bytes: Buffer }[] = [];
  const included = new Map<string, boolean>();
  // Every file is tried in full first, so the pack page can say which ones are attached.
  const scratch = await PDFDocument.create();
  for (const f of p.files) {
    try {
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(f.mime_type)) throw new Error('not attachable');
      const bytes = await storage.get(f.storage_key);
      if (f.mime_type === 'application/pdf') {
        const src = await PDFDocument.load(bytes);
        if (src.getPageCount() === 0) throw new Error('no pages');
        await scratch.copyPages(src, src.getPageIndices());
      } else if (f.mime_type === 'image/png') {
        await scratch.embedPng(bytes);
      } else {
        await scratch.embedJpg(bytes);
      }
      included.set(f.id, true);
      loaded.push({ file: f, bytes });
    } catch {
      included.set(f.id, false);
    }
  }
  const out = await PDFDocument.load(await render(packHtml(p, included)));
  out.setTitle(`${p.detail.row.ref_code} ملف طلب التنفيذ`);
  out.setProducer('Talos Debt Follow-up');
  out.setCreator('Talos Debt Follow-up');
  for (const { file, bytes } of loaded) {
    if (file.mime_type === 'application/pdf') {
      const src = await PDFDocument.load(bytes);
      for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
    } else {
      const img = file.mime_type === 'image/png' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      // A4 in points, with a margin; the photo keeps its shape.
      const [W, H, M] = [595.28, 841.89, 36];
      const scale = Math.min((W - 2 * M) / img.width, (H - 2 * M) / img.height, 1);
      const page = out.addPage([W, H]);
      page.drawImage(img, { x: (W - img.width * scale) / 2, y: (H - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
    }
  }
  return { bytes: Buffer.from(await out.save()), included };
}
