/**
 * Checks for whole records (a debtor, a debt, an instrument), built from
 * the value rules in normalize.ts. Manual entry (routes/debtors.ts) and the
 * Excel import (import/validate.ts) both call these, so a value accepted in
 * one is accepted in the other.
 */
import type { Db } from '../db.js';
import * as n from './normalize.js';

export interface Issue {
  field: string;
  message: string;
}

export interface Checked<T> {
  value: T;
  errors: Issue[];
  warnings: Issue[];
}

/** Collects errors and warnings while reading fields. */
class Collector {
  errors: Issue[] = [];
  warnings: Issue[] = [];

  take<T>(field: string, c: n.Check<T>): T | undefined {
    if (!c.ok) {
      this.errors.push({ field, message: c.error });
      return undefined;
    }
    if (c.warning) this.warnings.push({ field, message: c.warning });
    return c.value;
  }

  error(field: string, message: string) {
    this.errors.push({ field, message });
  }

  warn(field: string, message: string) {
    this.warnings.push({ field, message });
  }
}

const has = (input: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(input, key);

// ---------------------------------------------------------------------
// Debtor
// ---------------------------------------------------------------------

export interface DebtorFields {
  id_type: n.IdType;
  id_number: string;
  full_name: string;
  full_name_ar: string | null;
  debtor_kind: 'person' | 'company';
  nationality: string | null;
  preferred_language: 'ar' | 'en' | 'ur' | 'bn' | 'hi';
  national_address: string | null;
  employment_status: 'current' | 'left' | 'unknown';
  ref_code: string | null;
  notes: string | null;
}

const idTypeOf = n.matcher(n.ID_TYPE_CHOICES);
const kindOf = n.matcher(n.DEBTOR_KIND_CHOICES);
const languageOf = n.matcher(n.LANGUAGE_CHOICES);
const employmentOf = n.matcher(n.EMPLOYMENT_CHOICES);
const reasonOf = n.matcher(n.REASON_CHOICES);

function listValue<T extends string>(
  c: Collector,
  field: string,
  raw: unknown,
  match: (v: unknown) => T | undefined,
  label: string,
): T | undefined {
  if (n.isBlank(raw)) return undefined;
  const v = match(raw);
  if (!v) c.error(field, `${label} "${n.text(raw)}" is not one of the allowed values`);
  return v;
}

/**
 * mode 'create': required fields must be there; empty optional fields get defaults.
 * mode 'update': only the fields present in input are checked and returned.
 */
export function checkDebtor(input: Record<string, unknown>, mode: 'create' | 'update'): Checked<Partial<DebtorFields>> {
  const c = new Collector();
  const out: Partial<DebtorFields> = {};
  const want = (k: string) => mode === 'create' || has(input, k);

  if (want('id_type') || want('id_number')) {
    let type = listValue(c, 'id_type', input.id_type, idTypeOf, 'ID type');
    if (!type && n.isBlank(input.id_type)) type = n.guessIdType(input.id_number);
    if (!type && n.isBlank(input.id_type)) {
      if (mode === 'create' || has(input, 'id_number')) c.error('id_type', 'ID type is empty');
    }
    if (type) {
      const num = c.take('id_number', n.idNumber(type, input.id_number));
      if (num) {
        out.id_type = type;
        out.id_number = num;
      }
    }
  }
  if (want('full_name')) {
    const v = c.take('full_name', n.requiredText(input.full_name, 'Full name', 2, 200));
    if (v) out.full_name = v;
  }
  if (want('full_name_ar')) {
    out.full_name_ar = c.take('full_name_ar', n.optionalText(input.full_name_ar, 'Name in Arabic', 200)) ?? null;
  }
  if (want('debtor_kind')) {
    out.debtor_kind =
      listValue(c, 'debtor_kind', input.debtor_kind, kindOf, 'Debtor type') ??
      (out.id_type === 'cr' ? 'company' : 'person');
  }
  if (want('nationality')) out.nationality = c.take('nationality', n.nationality(input.nationality)) ?? null;
  if (want('preferred_language')) {
    out.preferred_language = listValue(c, 'preferred_language', input.preferred_language, languageOf, 'Language') ?? 'ar';
  }
  if (want('national_address')) {
    out.national_address = c.take('national_address', n.optionalText(input.national_address, 'Address', 300)) ?? null;
  }
  if (want('employment_status')) {
    out.employment_status =
      listValue(c, 'employment_status', input.employment_status, employmentOf, 'Employment status') ?? 'unknown';
  }
  if (want('ref_code')) out.ref_code = c.take('ref_code', n.reference(input.ref_code, 'Debtor reference')) ?? null;
  if (want('notes')) out.notes = c.take('notes', n.optionalText(input.notes, 'Notes', 2000)) ?? null;

  return { value: out, errors: c.errors, warnings: c.warnings };
}

/** Phones: cleaned, without repeats, in the order given. */
export function checkPhones(list: unknown[], field = 'phones'): Checked<string[]> {
  const c = new Collector();
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    if (n.isBlank(raw)) return;
    const p = c.take(`${field}[${i}]`, n.phone(raw));
    if (p) seen.add(p);
  });
  return { value: [...seen], errors: c.errors, warnings: c.warnings };
}

// ---------------------------------------------------------------------
// Debt
// ---------------------------------------------------------------------

export interface DebtFields {
  ref_code: string | null;
  amount_original: string;
  reason: string;
  reason_category: n.ReasonCategory;
  issue_date: string | null;
  due_date: string | null;
}

export function checkDebt(input: Record<string, unknown>, mode: 'create' | 'update', today = n.todayInRiyadh()): Checked<Partial<DebtFields>> {
  const c = new Collector();
  const out: Partial<DebtFields> = {};
  const want = (k: string) => mode === 'create' || has(input, k);

  if (want('ref_code')) out.ref_code = c.take('ref_code', n.reference(input.ref_code, 'Debt reference')) ?? null;
  if (want('amount')) {
    const v = c.take('amount', n.amount(input.amount));
    if (v) out.amount_original = v;
  }
  if (want('reason')) {
    const v = c.take('reason', n.requiredText(input.reason, 'Reason', 3, 500));
    if (v) out.reason = v;
  }
  if (want('reason_category')) {
    out.reason_category = listValue(c, 'reason_category', input.reason_category, reasonOf, 'Reason type') ?? 'other';
  }
  if (want('issue_date')) out.issue_date = c.take('issue_date', n.date(input.issue_date, 'Issue date')) ?? null;
  if (want('due_date')) out.due_date = c.take('due_date', n.date(input.due_date, 'Due date')) ?? null;

  if (out.issue_date && out.due_date && out.due_date < out.issue_date) {
    c.error('due_date', `Due date ${out.due_date} is before the issue date ${out.issue_date}`);
  }
  if (out.issue_date && out.issue_date > today) {
    c.warn('issue_date', `Issue date ${out.issue_date} is in the future`);
  }
  return { value: out, errors: c.errors, warnings: c.warnings };
}

// ---------------------------------------------------------------------
// Instrument
// ---------------------------------------------------------------------

export interface InstrumentType {
  code: string;
  name_en: string;
  name_ar: string | null;
  najiz_main_type: string | null;
  najiz_sub_type: string | null;
  directly_enforceable: boolean;
  has_time_limit: boolean;
  sort_order: number;
}

export interface InstrumentFields {
  type_code: string;
  reference_number: string | null;
  issue_date: string | null;
  due_date: string | null;
  face_amount: string | null;
}

/** Words that mean "no instrument". */
const NONE_WORDS = new Set(['none', 'no', 'nothing', 'no instrument', 'لا يوجد', 'لا', 'بدون', 'n a', 'na'].map(n.simplify));

/** Extra words people use for instrument types, on top of the names in app.instrument_types. */
const INSTRUMENT_ALIASES: Record<string, string[]> = {
  nafith_promissory_note: ['nafith', 'nafith note', 'electronic promissory note', 'e promissory note', 'نافذ', 'سند لأمر نافذ', 'سند إلكتروني'],
  paper_promissory_note: ['promissory note', 'paper note', 'سند لأمر', 'سند', 'سند ورقي'],
  cheque: ['check', 'شيك'],
  bill_of_exchange: ['كمبيالة'],
  court_judgment: ['judgment', 'court order', 'حكم'],
  labor_judgment: ['labor court', 'labour judgment', 'حكم عمالي'],
  notarized_contract: ['notarised contract', 'عقد موثق'],
  ejar_lease: ['ejar', 'إيجار', 'ايجار'],
  plain_contract: ['contract', 'عقد'],
  invoice: ['فاتورة'],
};

export function instrumentTypeMatcher(types: readonly InstrumentType[]) {
  const choices: n.Choice<string>[] = types.map((t) => ({
    code: t.code,
    en: t.name_en,
    ar: t.name_ar ?? t.name_en,
    also: INSTRUMENT_ALIASES[t.code] ?? [],
  }));
  const match = n.matcher(choices);
  /** undefined = not recognised, null = "no instrument", otherwise the code. */
  return (raw: unknown): string | null | undefined => {
    const t = n.text(raw);
    if (!t) return null;
    if (NONE_WORDS.has(n.simplify(t))) return null;
    for (const part of t.split(/\s*[/|]\s*/)) if (NONE_WORDS.has(n.simplify(part))) return null;
    return match(raw);
  };
}

/**
 * Returns value null when the debt has no instrument (the type is empty or "none").
 * input: type (code or label), reference_number, issue_date, due_date, face_amount
 */
export function checkInstrument(
  input: Record<string, unknown>,
  types: readonly InstrumentType[],
  mode: 'create' | 'update' = 'create',
): Checked<Partial<InstrumentFields> | null> {
  const c = new Collector();
  const out: Partial<InstrumentFields> = {};
  const want = (k: string) => mode === 'create' || has(input, k);

  if (want('type')) {
    const code = instrumentTypeMatcher(types)(input.type);
    if (code === undefined) {
      c.error('instrument_type', `Instrument type "${n.text(input.type)}" is not one of the allowed values`);
    } else if (code === null) {
      if (mode === 'create') {
        const extra = ['reference_number', 'issue_date', 'face_amount'].some((k) => !n.isBlank(input[k]));
        if (extra) c.warn('instrument_type', 'Instrument details were given but no instrument type, so they were ignored');
        return { value: null, errors: c.errors, warnings: c.warnings };
      }
      c.error('instrument_type', 'Instrument type is empty');
    } else {
      out.type_code = code;
    }
  }
  if (want('reference_number')) {
    out.reference_number = c.take('instrument_reference', n.instrumentReference(input.reference_number)) ?? null;
  }
  if (want('issue_date')) out.issue_date = c.take('instrument_issue_date', n.date(input.issue_date, 'Instrument issue date')) ?? null;
  if (want('due_date')) out.due_date = c.take('instrument_due_date', n.date(input.due_date, 'Instrument due date')) ?? null;
  if (want('face_amount')) {
    out.face_amount = n.isBlank(input.face_amount)
      ? null
      : (c.take('instrument_amount', n.amount(input.face_amount, 'Instrument amount')) ?? null);
  }

  if (mode === 'create' && out.type_code && !out.reference_number) {
    const t = types.find((x) => x.code === out.type_code);
    if (t?.directly_enforceable) {
      c.warn('instrument_reference', `Add the ${t.name_en} reference number: it is needed for the Najiz filing`);
    }
  }
  return { value: out, errors: c.errors, warnings: c.warnings };
}

export async function loadInstrumentTypes(db: Db): Promise<InstrumentType[]> {
  const { rows } = await db.query<InstrumentType>(
    `SELECT code, name_en, name_ar, najiz_main_type, najiz_sub_type, directly_enforceable, has_time_limit, sort_order
       FROM app.instrument_types ORDER BY sort_order, code`,
  );
  return rows;
}

export { reasonOf };
