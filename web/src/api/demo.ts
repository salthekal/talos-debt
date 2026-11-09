/**
 * Sample data for design review and the clickable prototype. Made-up
 * people only. Shapes match the API exactly, so the same screens later
 * run on real data with no change.
 */
import { share, subtract, sum } from '../lib/money';
import type { DataSource, DebtQuery } from './source';
import type {
  Approvals, DebtorDetail, DebtRow, DebtStatus, Debtor, Language, Notification, Phone, TimelineEvent, WaitingReminder,
} from './types';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const ahead = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const day = (offsetDays: number) => new Date(NOW + offsetDays * 86_400_000).toISOString().slice(0, 10);

interface Seed {
  name: string;
  nameAr?: string;
  nationality: string;
  lang: Language;
  idType: 'iqama' | 'national_id';
  debts: {
    original: string;
    outstanding: string;
    status: DebtStatus;
    attempts: number;
    instrument: string;
    reason: string;
    lastContact?: number; // hours ago
    lastReply?: number;
  }[];
}

const SEEDS: Seed[] = [
  { name: 'Imran Khan', nationality: 'PK', lang: 'ur', idType: 'iqama', debts: [
    { original: '3450.00', outstanding: '3450.00', status: 'in_follow_up', attempts: 4, instrument: 'nafith_promissory_note', reason: 'Motorcycle rent, March to May', lastContact: 30 } ] },
  { name: 'Fahad Al-Otaibi', nameAr: 'فهد العتيبي', nationality: 'SA', lang: 'ar', idType: 'national_id', debts: [
    { original: '1280.50', outstanding: '1280.50', status: 'promised', attempts: 2, instrument: 'paper_promissory_note', reason: 'Cash on delivery not handed over', lastContact: 52, lastReply: 50 } ] },
  { name: 'Rahim Uddin', nationality: 'BD', lang: 'bn', idType: 'iqama', debts: [
    { original: '2100.00', outstanding: '2100.00', status: 'in_follow_up', attempts: 2, instrument: 'paper_promissory_note', reason: 'Damage to delivery box and bike', lastContact: 70, lastReply: 3 } ] },
  { name: 'Ahmed Saleh', nameAr: 'أحمد صالح', nationality: 'YE', lang: 'ar', idType: 'iqama', debts: [
    { original: '1500.00', outstanding: '1500.00', status: 'disputed', attempts: 1, instrument: 'none', reason: 'Traffic fines during shifts', lastContact: 96, lastReply: 20 } ] },
  { name: 'Suresh Kumar', nationality: 'IN', lang: 'en', idType: 'iqama', debts: [
    { original: '2500.00', outstanding: '1000.00', status: 'partly_paid', attempts: 2, instrument: 'nafith_promissory_note', reason: 'Salary advance', lastContact: 26 } ] },
  { name: 'Bilal Ahmed', nationality: 'PK', lang: 'ur', idType: 'iqama', debts: [
    { original: '4200.00', outstanding: '4200.00', status: 'legal_ready', attempts: 5, instrument: 'nafith_promissory_note', reason: 'Motorcycle rent, absconded', lastContact: 75 } ] },
  { name: 'Mohammed Al-Zahrani', nameAr: 'محمد الزهراني', nationality: 'SA', lang: 'ar', idType: 'national_id', debts: [
    { original: '900.00', outstanding: '0.00', status: 'paid', attempts: 1, instrument: 'cheque', reason: 'Uniform and phone', lastContact: 200, lastReply: 190 } ] },
  { name: 'Abdul Karim', nationality: 'BD', lang: 'bn', idType: 'iqama', debts: [
    { original: '1750.00', outstanding: '1750.00', status: 'open', attempts: 0, instrument: 'paper_promissory_note', reason: 'Cash on delivery not handed over' } ] },
  { name: 'Rajesh Nair', nationality: 'IN', lang: 'hi', idType: 'iqama', debts: [
    { original: '3100.00', outstanding: '2300.00', status: 'promised', attempts: 3, instrument: 'nafith_promissory_note', reason: 'Motorcycle rent', lastContact: 48, lastReply: 46 } ] },
  { name: 'Yasir Hassan', nameAr: 'ياسر حسن', nationality: 'EG', lang: 'ar', idType: 'iqama', debts: [
    { original: '2650.00', outstanding: '2650.00', status: 'in_follow_up', attempts: 3, instrument: 'nafith_promissory_note', reason: 'Car rent, two months', lastContact: 22 } ] },
  { name: 'Kamal Hossain', nationality: 'BD', lang: 'bn', idType: 'iqama', debts: [
    { original: '1320.00', outstanding: '1320.00', status: 'paused', attempts: 2, instrument: 'paper_promissory_note', reason: 'Fuel card over limit', lastContact: 140 } ] },
  { name: 'Omar Farouk', nameAr: 'عمر فاروق', nationality: 'SD', lang: 'ar', idType: 'iqama', debts: [
    { original: '5800.00', outstanding: '5800.00', status: 'in_legal', attempts: 5, instrument: 'nafith_promissory_note', reason: 'Car rent and damage', lastContact: 400 } ] },
  { name: 'Tariq Mehmood', nationality: 'PK', lang: 'ur', idType: 'iqama', debts: [
    { original: '760.00', outstanding: '0.00', status: 'paid', attempts: 2, instrument: 'none', reason: 'Salary advance', lastContact: 120, lastReply: 118 } ] },
  { name: 'Sami Al-Harbi', nameAr: 'سامي الحربي', nationality: 'SA', lang: 'ar', idType: 'national_id', debts: [
    { original: '1980.00', outstanding: '1980.00', status: 'open', attempts: 0, instrument: 'nafith_promissory_note', reason: 'Motorcycle rent' } ] },
  { name: 'Anwar Hossain', nationality: 'BD', lang: 'bn', idType: 'iqama', debts: [
    { original: '2240.00', outstanding: '1240.00', status: 'partly_paid', attempts: 3, instrument: 'paper_promissory_note', reason: 'Damage to motorcycle', lastContact: 33, lastReply: 31 } ] },
  { name: 'Faisal Qureshi', nationality: 'PK', lang: 'en', idType: 'iqama', debts: [
    { original: '3900.00', outstanding: '3900.00', status: 'in_follow_up', attempts: 1, instrument: 'cheque', reason: 'Cash on delivery not handed over', lastContact: 6 },
    { original: '650.00', outstanding: '650.00', status: 'open', attempts: 0, instrument: 'none', reason: 'Phone not returned' } ] },
];

/** Reasons in Arabic, for the reminders sent to Arabic speakers. */
const REASON_AR: Record<string, string> = {
  'Cash on delivery not handed over': 'مبالغ الدفع عند الاستلام لم تُسلَّم',
  'Traffic fines during shifts': 'مخالفات مرورية أثناء العمل',
  'Uniform and phone': 'الزي الرسمي والجوال',
  'Car rent, two months': 'إيجار سيارة لشهرين',
  'Car rent and damage': 'إيجار سيارة وأضرار',
  'Motorcycle rent': 'إيجار دراجة نارية',
};

const uuid = (prefix: number, n: number) => `${prefix}${prefix}${prefix}${prefix}${prefix}${prefix}${prefix}${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const debtors: Debtor[] = [];
const phones = new Map<string, Phone[]>();
const debts: DebtRow[] = [];
const timeline = new Map<string, TimelineEvent[]>();
let debtNo = 1;

SEEDS.forEach((s, i) => {
  const id = uuid(3, i + 1);
  debtors.push({
    id, ref_code: `D-${String(i + 1).padStart(6, '0')}`, debtor_kind: 'courier', id_type: s.idType,
    id_number: `${s.idType === 'national_id' ? 1 : 2}${String(108459320 + i * 7919).slice(0, 9)}`,
    full_name: s.name, full_name_ar: s.nameAr ?? null, nationality: s.nationality, preferred_language: s.lang,
    employment_status: s.debts.some((d) => d.reason.includes('absconded')) ? 'left' : 'current',
    status: 'active', notes: null, created_at: ago(24 * 40 + i * 5),
  });
  phones.set(id, [
    { id: uuid(4, i * 2 + 1), phone_e164: `+9665${String(40000000 + i * 1234567).slice(0, 8)}`, label: 'Mobile', is_primary: true, has_whatsapp: true, status: 'active' },
    ...(i % 4 === 0 ? [{ id: uuid(4, i * 2 + 2), phone_e164: `+9665${String(70000000 + i * 765431).slice(0, 8)}`, label: 'Second number', is_primary: false, has_whatsapp: i !== 0, status: (i === 0 ? 'wrong_number' : 'active') as Phone['status'] }] : []),
  ]);
  const events: TimelineEvent[] = [];
  for (const d of s.debts) {
    const debtId = uuid(6, debtNo);
    debts.push({
      client_id: CLIENT, debt_id: debtId, ref_code: `DBT-2026-${String(debtNo).padStart(4, '0')}`, debtor_id: id, full_name: s.name,
      amount_original: d.original, amount_outstanding: d.outstanding, status: d.status, attempts_count: d.attempts,
      last_contact_at: d.lastContact ? ago(d.lastContact) : null, last_reply_at: d.lastReply ? ago(d.lastReply) : null,
      instrument_type: d.instrument,
      directly_enforceable: ['nafith_promissory_note', 'paper_promissory_note', 'cheque', 'court_judgment', 'notarized_contract'].includes(d.instrument),
      enforceable_until: null,
    });
    debtNo++;
    // A believable history for each debt.
    for (let a = 0; a < d.attempts; a++) {
      const h = (d.lastContact ?? 48) + (d.attempts - 1 - a) * 48;
      events.push({ kind: 'message', id: `${debtId}-m${a}`, debt_id: debtId, at: ago(h), data: {
        direction: 'outbound', channel: 'whatsapp', ai_generated: false,
        status: a === d.attempts - 1 && !d.lastReply ? 'delivered' : 'read',
        body: s.lang === 'ar'
          ? `مرحباً ${s.nameAr ?? s.name}، نذكّرك بمبلغ ${d.outstanding} ر.س المستحق لشركة النخبة للتوصيل (${REASON_AR[d.reason] ?? d.reason}). للاستفسار ردّ على هذه الرسالة.`
          : `Hello ${s.name}, this is a reminder from Al Nokhba Delivery: SAR ${d.outstanding} is still owed (${d.reason}). Reply to this message with any question.`,
      } });
    }
    if (d.lastReply) {
      const reply: Record<string, [string, string]> = {
        promised: ['I will pay on the 15th, salary comes then', 'إن شاء الله أسدد يوم 15 بعد ما ينزل الراتب'],
        disputed: ['This is wrong, I paid these fines myself last month', 'المبلغ غلط، المخالفات دفعتها بنفسي الشهر الماضي'],
        paid: ['Transferred today, receipt attached', 'حولت اليوم والإيصال مرفق'],
        partly_paid: ['I sent 1000 now, the rest next month', 'أرسلت 1000 الآن والباقي الشهر القادم'],
        in_follow_up: ['How much exactly is left?', 'كم المبلغ المتبقي بالضبط؟'],
      };
      const [enMsg, arMsg] = reply[d.status] ?? reply.in_follow_up!;
      events.push({ kind: 'message', id: `${debtId}-r`, debt_id: debtId, at: ago(d.lastReply), data: {
        direction: 'inbound', channel: 'whatsapp', ai_generated: false, status: 'received', body: s.lang === 'ar' ? arMsg : enMsg } });
      events.push({ kind: 'message', id: `${debtId}-ai`, debt_id: debtId, at: ago(d.lastReply - 0.02), data: {
        direction: 'outbound', channel: 'whatsapp', ai_generated: true, status: 'read',
        body: s.lang === 'ar'
          ? (d.status === 'disputed' ? 'شكراً لتوضيحك. أوقفنا التذكيرات وسيراجع فريقنا المبلغ ويتواصل معك.' : `شكراً لك. المبلغ المتبقي ${d.outstanding} ر.س.`)
          : (d.status === 'disputed' ? 'Thank you for telling us. We have stopped reminders and our team will review the amount.' : `Thank you. SAR ${d.outstanding} is left on this debt.`),
      } });
    }
    if (d.status === 'promised') {
      events.push({ kind: 'promise', id: `${debtId}-p`, debt_id: debtId, at: ago((d.lastReply ?? 50) - 0.03), data: { promised_amount: null, promised_date: day(5), status: 'pending' } });
    }
    if (d.status === 'disputed') {
      events.push({ kind: 'dispute', id: `${debtId}-d`, debt_id: debtId, at: ago((d.lastReply ?? 20) - 0.03), data: { reason: 'Says he paid the traffic fines himself last month', status: 'open', resolution_note: null } });
    }
    if (d.status === 'partly_paid' || d.status === 'paid') {
      events.push({ kind: 'payment', id: `${debtId}-pay`, debt_id: debtId, at: ago((d.lastReply ?? 30) - 0.05), data: {
        amount: subtract(d.original, d.outstanding), method: 'bank_transfer', status: 'approved', rejection_reason: null } });
    }
  }
  timeline.set(id, events.sort((a, b) => b.at.localeCompare(a.at)));
});

// Rahim sent a receipt that waits for review; Faisal too.
const rahim = debts.find((d) => d.full_name === 'Rahim Uddin')!;
const faisal = debts.find((d) => d.full_name === 'Faisal Qureshi')!;
const payments: Approvals['payments'] = [
  { id: uuid(9, 1), amount: '1000.00', method: 'bank_transfer', paid_at: ago(4), proof_document_id: uuid(8, 1), created_at: ago(3),
    extracted_details: { bank: 'Al Rajhi Bank', reference: 'FT26313884511', date: day(0) }, ai_match_confidence: '0.94',
    debt_id: rahim.debt_id, debt_ref: rahim.ref_code, amount_outstanding: rahim.amount_outstanding, debtor_id: rahim.debtor_id, full_name: rahim.full_name },
  { id: uuid(9, 2), amount: '3900.00', method: 'bank_transfer', paid_at: ago(5), proof_document_id: uuid(8, 2), created_at: ago(5),
    extracted_details: { bank: 'Saudi National Bank', reference: '2611090047731', date: day(0) }, ai_match_confidence: '0.81',
    debt_id: faisal.debt_id, debt_ref: faisal.ref_code, amount_outstanding: faisal.amount_outstanding, debtor_id: faisal.debtor_id, full_name: faisal.full_name },
];
timeline.get(rahim.debtor_id)!.unshift({ kind: 'payment', id: payments[0]!.id, debt_id: rahim.debt_id, at: ago(3), data: { amount: '1000.00', method: 'bank_transfer', status: 'pending_approval', rejection_reason: null } });

const ahmed = debts.find((d) => d.status === 'disputed')!;
const disputes: Approvals['disputes'] = [
  { id: uuid(5, 1), reason: 'Says he paid the traffic fines himself last month', created_at: ago(20), debt_id: ahmed.debt_id,
    debt_ref: ahmed.ref_code, amount_outstanding: ahmed.amount_outstanding, debtor_id: ahmed.debtor_id, full_name: ahmed.full_name },
];

let reminders: WaitingReminder[] = debts
  .filter((d) => ['open', 'in_follow_up', 'partly_paid'].includes(d.status) && d.full_name !== 'Rahim Uddin')
  .slice(0, 6)
  .map((d, i) => {
    const debtor = debtors.find((x) => x.id === d.debtor_id)!;
    return { task_id: uuid(7, i + 1), due_at: ahead(i < 3 ? 1 + i : 18 + i), attempt_number: d.attempts_count + 1, debt_id: d.debt_id,
      ref_code: d.ref_code, amount_outstanding: d.amount_outstanding, debt_status: d.status, debtor_id: d.debtor_id,
      full_name: d.full_name, preferred_language: debtor.preferred_language };
  });

const bilal = debts.find((d) => d.status === 'legal_ready')!;
const notifications: Notification[] = [
  { id: 'n1', kind: 'payment_to_review', title: 'Rahim Uddin sent a receipt for SAR 1,000 (DBT-2026-0003)', target_table: 'app.debts', target_id: rahim.debt_id, read_at: null, created_at: ago(3), data: { name: rahim.full_name, ref: rahim.ref_code, amount: '1000.00' } },
  { id: 'n2', kind: 'reply', title: 'Rahim Uddin asked how much is left on DBT-2026-0003', target_table: 'app.debts', target_id: rahim.debt_id, read_at: null, created_at: ago(3.1), data: { name: rahim.full_name, ref: rahim.ref_code } },
  { id: 'n3', kind: 'payment_to_review', title: 'Faisal Qureshi sent a receipt for SAR 3,900 (DBT-2026-0016)', target_table: 'app.debts', target_id: faisal.debt_id, read_at: null, created_at: ago(5), data: { name: faisal.full_name, ref: faisal.ref_code, amount: '3900.00' } },
  { id: 'n4', kind: 'dispute', title: 'Ahmed Saleh says the amount on DBT-2026-0004 is wrong', target_table: 'app.debts', target_id: ahmed.debt_id, read_at: ago(10), created_at: ago(20), data: { name: ahmed.full_name, ref: ahmed.ref_code } },
  { id: 'n5', kind: 'legal_ready', title: 'DBT-2026-0006 (Bilal Ahmed) is ready for legal: 5 reminders and no reply', target_table: 'app.debts', target_id: bilal.debt_id, read_at: null, created_at: ago(26), data: { name: bilal.full_name, ref: bilal.ref_code, reminders: 5 } },
  { id: 'n6', kind: 'system', title: 'Daily summary: 9 reminders sent, 3 replies, 1 promise to pay, 2 payments to review', target_table: 'daily_summary', target_id: null, read_at: ago(30), created_at: ago(31), data: { summary: { sent: 9, replies: 3, promises: 1, payments: 2 } } },
];

const pause = <T>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), 120));

export const demoSource: DataSource = {
  demo: true,
  me: () => pause({ user: { id: 'u1', fullName: 'Noura Al-Qahtani', role: 'staff' as const },
    client: { id: CLIENT, legal_name: 'Al Nokhba Delivery Co.', trade_name: 'Al Nokhba Delivery', sector: 'logistics', plan: 'growth', status: 'active' } }),
  totals: () => {
    const open = debts.filter((d) => !['paid', 'closed', 'written_off'].includes(d.status));
    const enforceable = open.filter((d) => d.directly_enforceable);
    const sumOf = (rows: DebtRow[]) => sum(rows.map((d) => d.amount_outstanding));
    return pause({
      total_owed: sum(debts.map((d) => d.amount_original)),
      recovered: sum(debts.map((d) => subtract(d.amount_original, d.amount_outstanding))),
      promised: sumOf(debts.filter((d) => d.status === 'promised')),
      disputed: sumOf(debts.filter((d) => d.status === 'disputed')),
      in_legal: sumOf(debts.filter((d) => d.status === 'legal_ready' || d.status === 'in_legal')),
      open_balance: sumOf(open),
      enforceable_share_pct: share(sumOf(enforceable), sumOf(open)),
      paper_notes_at_risk: open.filter((d) => d.instrument_type === 'paper_promissory_note').length,
    });
  },
  debts: (q: DebtQuery) => {
    const s = q.search?.toLowerCase();
    const rows = debts
      .filter((d) => !q.status || d.status === q.status)
      .filter((d) => !s || d.full_name.toLowerCase().includes(s) || d.ref_code.toLowerCase().includes(s))
      .sort((a, b) => (b.last_contact_at ?? '').localeCompare(a.last_contact_at ?? ''));
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    return pause({ total: rows.length, limit, offset, items: rows.slice(offset, offset + limit) });
  },
  statusCounts: () => {
    const counts: Partial<Record<DebtStatus, number>> = {};
    for (const d of debts) counts[d.status] = (counts[d.status] ?? 0) + 1;
    return pause(counts);
  },
  debtor: (id: string) => {
    const debtor = debtors.find((d) => d.id === id);
    if (!debtor) return Promise.reject(new Error('not_found'));
    const detail: DebtorDetail = { debtor, phones: phones.get(id) ?? [], debts: debts.filter((d) => d.debtor_id === id), timeline: timeline.get(id) ?? [] };
    return pause(detail);
  },
  approvals: () => pause({ payments, disputes }),
  waitingReminders: () => pause({ auto_send: false, reminders }),
  notifications: () => pause(notifications),
  rules: () => pause({ interval_days: 2, max_attempts: 5, auto_send: false }),
  approveReminders: (ids) => {
    const n = ids === 'all' ? reminders.length : reminders.filter((r) => ids.includes(r.task_id)).length;
    reminders = ids === 'all' ? [] : reminders.filter((r) => !ids.includes(r.task_id));
    return pause({ approved: n });
  },
  approvePayment: async () => undefined,
  rejectPayment: async () => undefined,
};
