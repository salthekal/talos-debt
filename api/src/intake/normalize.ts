/**
 * One set of rules for every value that comes in, whether a person types it
 * in a form (3.2) or it comes from an Excel sheet (3.1). Each check either
 * returns a clean value (sometimes with a warning) or an error message
 * written for the client's staff.
 *
 * Errors stop the record from being saved. Warnings do not: they point at
 * something that is probably right but worth a second look.
 */

export type Check<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

const ok = <T>(value: T, warning?: string): Check<T> => (warning ? { ok: true, value, warning } : { ok: true, value });
const fail = <T>(error: string): Check<T> => ({ ok: false, error });

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to 0-9. Excel sheets from Saudi companies often have them. */
export function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Trimmed text, or undefined when empty. Numbers become text. */
export function text(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[‎‏‪-‮ ]/g, ' ').replace(/\s+/g, ' ').trim();
  return s === '' ? undefined : s;
}

export const isBlank = (v: unknown) => text(v) === undefined;

/** Lower case, no punctuation or extra spaces: used to compare names and list values. */
export function simplify(s: string): string {
  return latinDigits(s)
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '') // Arabic diacritics and tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// ---------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------

/**
 * Accepts 05XXXXXXXX, 5XXXXXXXX, 9665XXXXXXXX, +9665XXXXXXXX, 009665XXXXXXXX,
 * with spaces or dashes, and foreign numbers written with + or 00.
 * Returns +E.164, for example +966501234567.
 */
export function phone(raw: unknown): Check<string> {
  const t = text(raw);
  if (!t) return fail('Phone number is empty');
  let s = latinDigits(t).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;

  let e164: string;
  if (s.startsWith('+')) {
    let digits = s.slice(1);
    if (!/^\d+$/.test(digits)) return fail(`"${t}" is not a phone number`);
    // +966 05... written by mistake
    if (digits.startsWith('9660')) digits = `966${digits.slice(4)}`;
    e164 = `+${digits}`;
  } else if (/^05\d{8}$/.test(s)) {
    e164 = `+966${s.slice(1)}`;
  } else if (/^5\d{8}$/.test(s)) {
    // Excel drops the leading 0 when the cell is a number.
    e164 = `+966${s}`;
  } else if (/^966\d{9}$/.test(s)) {
    e164 = `+${s}`;
  } else if (/^\d+$/.test(s)) {
    return fail(`"${t}": add the country code (for example +92...), or write Saudi numbers as 05XXXXXXXX`);
  } else {
    return fail(`"${t}" is not a phone number`);
  }

  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return fail(`"${t}" is not a valid phone number`);
  if (e164.startsWith('+966')) {
    if (!/^\+966\d{9}$/.test(e164)) return fail(`"${t}": Saudi numbers have 9 digits after +966`);
    if (!e164.startsWith('+9665')) {
      return ok(e164, `"${t}" is not a Saudi mobile number, so WhatsApp may not reach it`);
    }
  }
  return ok(e164);
}

// ---------------------------------------------------------------------
// ID numbers
// ---------------------------------------------------------------------

export const ID_TYPES = ['national_id', 'iqama', 'passport', 'cr', 'other'] as const;
export type IdType = (typeof ID_TYPES)[number];

/** Saudi national ID and iqama numbers end with a check digit (the Luhn method). */
export function saudiIdCheckDigitOk(id: string): boolean {
  let sum = 0;
  for (let i = 0; i < id.length; i++) {
    const d = Number(id[i]);
    if (i % 2 === 0) {
      const x = d * 2;
      sum += Math.floor(x / 10) + (x % 10);
    } else {
      sum += d;
    }
  }
  return sum % 10 === 0;
}

/** Guess the ID type from the number when the type is left empty: 1... is a Saudi ID, 2... an iqama. */
export function guessIdType(rawNumber: unknown): IdType | undefined {
  const t = text(rawNumber);
  if (!t) return undefined;
  const s = latinDigits(t).replace(/[\s-]/g, '');
  if (/^1\d{9}$/.test(s)) return 'national_id';
  if (/^2\d{9}$/.test(s)) return 'iqama';
  return undefined;
}

export function idNumber(type: IdType, raw: unknown): Check<string> {
  const t = text(raw);
  if (!t) return fail('ID number is empty');
  const s = latinDigits(t).replace(/[\s-]/g, '').toUpperCase();
  switch (type) {
    case 'national_id':
    case 'iqama': {
      const first = type === 'national_id' ? '1' : '2';
      const label = type === 'national_id' ? 'A Saudi national ID' : 'An iqama number';
      if (!new RegExp(`^${first}\\d{9}$`).test(s)) return fail(`${label} has 10 digits and starts with ${first} ("${t}")`);
      return saudiIdCheckDigitOk(s)
        ? ok(s)
        : ok(s, `ID number ${s} fails the check digit test. Please make sure no digit is mistyped`);
    }
    case 'cr':
      return /^\d{10}$/.test(s) ? ok(s) : fail(`A commercial registration number has 10 digits ("${t}")`);
    case 'passport':
      return /^[A-Z0-9]{5,20}$/.test(s) ? ok(s) : fail(`"${t}" is not a valid passport number (5 to 20 letters and digits)`);
    case 'other':
      return /^[A-Z0-9/]{3,30}$/.test(s) ? ok(s) : fail(`"${t}" is not a valid ID number (3 to 30 letters and digits)`);
  }
}

// ---------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------

const MAX_AMOUNT_DIGITS = 10; // numeric(12,2)

/**
 * Amounts stay text from start to end (never a JavaScript number in the
 * database path), with exactly two decimals: "1500.00".
 * Accepts 1,500.50 / 1500 / ١٥٠٠ / "SAR 1500" / "1500 ر.س".
 */
export function amount(raw: unknown, label = 'Amount'): Check<string> {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return fail(`${label} must be more than 0`);
    const cents = Math.round(raw * 100);
    if (Math.abs(cents - raw * 100) > 1e-6) return fail(`${label} can have at most 2 decimals (${raw})`);
    const s = (cents / 100).toFixed(2);
    if (s.split('.')[0]!.length > MAX_AMOUNT_DIGITS) return fail(`${label} is too large (${raw})`);
    return ok(s);
  }
  const t = text(raw);
  if (!t) return fail(`${label} is empty`);
  const s = latinDigits(t)
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/[٬,\s]/g, '') // thousands separators and spaces
    .replace(/^(sar|sr|ر\.?س\.?|ريال)/i, '')
    .replace(/(sar|sr|ر\.?س\.?|ريال|ريالات)$/i, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) {
    if (/^\d+\.\d{3,}$/.test(s)) return fail(`${label} can have at most 2 decimals ("${t}")`);
    if (s.startsWith('-')) return fail(`${label} must be more than 0`);
    return fail(`${label} "${t}" is not a number`);
  }
  const whole = m[1]!.replace(/^0+(?=\d)/, '');
  if (whole.length > MAX_AMOUNT_DIGITS) return fail(`${label} is too large ("${t}")`);
  const value = `${whole}.${(m[2] ?? '').padEnd(2, '0')}`;
  if (/^0\.00$/.test(value)) return fail(`${label} must be more than 0`);
  return ok(value);
}

/** Compare two amounts written as text with 2 decimals. */
export function compareAmounts(a: string, b: string): number {
  const toCents = (x: string) => BigInt(x.replace('.', ''));
  const d = toCents(a) - toCents(b);
  return d === 0n ? 0 : d > 0n ? 1 : -1;
}

// ---------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

function isoDate(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Gregorian dates only: 2026-09-30, 30/09/2026, 30-09-2026, or an Excel date
 * cell. Day comes before month, as written in Saudi Arabia. Hijri dates are
 * refused with a clear message instead of being read as the wrong year.
 * Returns YYYY-MM-DD, or undefined when the cell is empty.
 */
export function date(raw: unknown, label = 'Date'): Check<string | undefined> {
  if (raw === null || raw === undefined || raw === '') return ok(undefined);
  let iso: string | undefined;
  let year: number | undefined;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return fail(`${label} is not a valid date`);
    year = raw.getUTCFullYear();
    iso = isoDate(year, raw.getUTCMonth() + 1, raw.getUTCDate());
  } else if (typeof raw === 'number') {
    // An Excel date stored as a plain number (days since 30 December 1899).
    if (!Number.isInteger(raw) || raw < 20000 || raw > 80000) return fail(`${label} "${raw}" is not a date`);
    const dt = new Date(Date.UTC(1899, 11, 30) + raw * 86400000);
    year = dt.getUTCFullYear();
    iso = isoDate(year, dt.getUTCMonth() + 1, dt.getUTCDate());
  } else {
    const t = text(raw);
    if (!t) return ok(undefined);
    const s = latinDigits(t).replace(/\s*(هـ|ه|ah|h)\s*$/i, (h) => (h ? ' H' : ''));
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
    if (m) {
      year = Number(m[1]);
      iso = isoDate(year, Number(m[2]), Number(m[3]));
    } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?: H)?$/.exec(s))) {
      year = Number(m[3]);
      iso = isoDate(year, Number(m[2]), Number(m[1]));
    } else {
      return fail(`${label} "${t}" is not a date. Use day/month/year, for example 30/09/2026`);
    }
    if (s.endsWith(' H')) year = 1400; // marked as Hijri
    if (!iso && year >= 1990) return fail(`${label} "${t}" is not a real date`);
  }

  if (year !== undefined && year >= 1300 && year < 1500) {
    return fail(`${label} looks like a Hijri date. Please use the Gregorian date`);
  }
  if (!iso || year === undefined) return fail(`${label} is not a valid date`);
  const thisYear = new Date().getUTCFullYear();
  if (year < 1990 || year > thisYear + 30) return fail(`${label} ${iso} is out of range`);
  return ok(iso);
}

/** Today in Riyadh, as YYYY-MM-DD. */
export function todayInRiyadh(now = new Date()): string {
  return new Date(now.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------
// Lists (dropdowns): accept the code, the English or the Arabic label
// ---------------------------------------------------------------------

export interface Choice<T extends string> {
  code: T;
  en: string;
  ar: string;
  /** Other words people type for the same thing. */
  also?: string[];
}

/** The label shown in Excel dropdowns: "English / عربي". */
export const choiceLabel = (c: { en: string; ar: string }) => `${c.en} / ${c.ar}`;

export function matcher<T extends string>(choices: readonly Choice<T>[]) {
  const map = new Map<string, T>();
  for (const c of choices) {
    for (const word of [c.code, c.code.replace(/_/g, ' '), c.en, c.ar, ...(c.also ?? [])]) {
      map.set(simplify(word), c.code);
    }
  }
  return (raw: unknown): T | undefined => {
    const t = text(raw);
    if (!t) return undefined;
    const whole = map.get(simplify(t));
    if (whole) return whole;
    // "English / عربي" from the template dropdown
    for (const part of t.split(/\s*[/|]\s*/)) {
      const hit = map.get(simplify(part));
      if (hit) return hit;
    }
    return undefined;
  };
}

export const ID_TYPE_CHOICES: Choice<IdType>[] = [
  { code: 'national_id', en: 'National ID', ar: 'هوية وطنية', also: ['saudi id', 'id', 'national id card', 'الهوية الوطنية', 'هوية'] },
  { code: 'iqama', en: 'Iqama', ar: 'إقامة', also: ['residence permit', 'resident id', 'iqamah', 'هوية مقيم'] },
  { code: 'passport', en: 'Passport', ar: 'جواز سفر', also: ['جواز'] },
  { code: 'cr', en: 'Commercial registration', ar: 'سجل تجاري', also: ['cr number', 'company', 'السجل التجاري'] },
  { code: 'other', en: 'Other', ar: 'أخرى', also: ['اخرى'] },
];

export const DEBTOR_KIND_CHOICES: Choice<'person' | 'company'>[] = [
  { code: 'person', en: 'Person', ar: 'فرد', also: ['individual', 'شخص', 'worker', 'employee', 'customer'] },
  { code: 'company', en: 'Company', ar: 'منشأة', also: ['business', 'شركة', 'مؤسسة'] },
];

export const LANGUAGE_CHOICES: Choice<'ar' | 'en' | 'ur' | 'bn' | 'hi'>[] = [
  { code: 'ar', en: 'Arabic', ar: 'العربية', also: ['عربي', 'arabi'] },
  { code: 'en', en: 'English', ar: 'الإنجليزية', also: ['انجليزي', 'إنجليزي'] },
  { code: 'ur', en: 'Urdu', ar: 'الأردية', also: ['اردو', 'أردو'] },
  { code: 'bn', en: 'Bengali', ar: 'البنغالية', also: ['bangla', 'بنغالي'] },
  { code: 'hi', en: 'Hindi', ar: 'الهندية', also: ['هندي'] },
];

export const EMPLOYMENT_CHOICES: Choice<'current' | 'left' | 'unknown'>[] = [
  { code: 'current', en: 'Still working', ar: 'على رأس العمل', also: ['working', 'active', 'employed', 'yes', 'حالي', 'نعم'] },
  { code: 'left', en: 'Left', ar: 'ترك العمل', also: ['left the company', 'terminated', 'resigned', 'absconded', 'no', 'غادر', 'منقطع', 'لا'] },
  { code: 'unknown', en: 'Unknown', ar: 'غير معروف', also: ['غير معروف'] },
];

export const REASON_CATEGORIES = [
  'vehicle_rent', 'cash_on_delivery', 'damages', 'advance', 'invoice', 'equipment', 'fine', 'other',
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

export const REASON_CHOICES: Choice<ReasonCategory>[] = [
  { code: 'vehicle_rent', en: 'Vehicle rent', ar: 'إيجار مركبة', also: ['rent', 'bike rent', 'car rent', 'motorcycle rent', 'إيجار'] },
  { code: 'cash_on_delivery', en: 'Cash on delivery not handed over', ar: 'مبالغ تحصيل لم تسلم', also: ['cash on delivery', 'cod', 'cash', 'تحصيل', 'كاش'] },
  { code: 'damages', en: 'Damages', ar: 'أضرار', also: ['damage', 'repair', 'accident', 'تلفيات', 'حادث'] },
  { code: 'advance', en: 'Salary advance', ar: 'سلفة', also: ['advance', 'loan', 'سلف'] },
  { code: 'invoice', en: 'Unpaid invoice', ar: 'فاتورة غير مدفوعة', also: ['invoice', 'فاتورة'] },
  { code: 'equipment', en: 'Equipment or uniform', ar: 'معدات أو زي', also: ['equipment', 'uniform', 'phone', 'معدات', 'عهدة'] },
  { code: 'fine', en: 'Fine or traffic violation', ar: 'غرامة أو مخالفة', also: ['fine', 'penalty', 'traffic fine', 'مخالفة', 'غرامة'] },
  { code: 'other', en: 'Other', ar: 'أخرى', also: ['اخرى'] },
];

/** Common nationalities of debtors, so names like "Pakistan" or "باكستاني" become codes. */
const NATIONALITIES: [string, string[]][] = [
  ['SA', ['saudi', 'saudi arabia', 'ksa', 'سعودي', 'السعودية']],
  ['PK', ['pakistan', 'pakistani', 'باكستان', 'باكستاني']],
  ['IN', ['india', 'indian', 'الهند', 'هندي']],
  ['BD', ['bangladesh', 'bangladeshi', 'بنغلاديش', 'بنغالي']],
  ['EG', ['egypt', 'egyptian', 'مصر', 'مصري']],
  ['YE', ['yemen', 'yemeni', 'اليمن', 'يمني']],
  ['SD', ['sudan', 'sudanese', 'السودان', 'سوداني']],
  ['PH', ['philippines', 'filipino', 'الفلبين', 'فلبيني']],
  ['NP', ['nepal', 'nepali', 'nepalese', 'نيبال', 'نيبالي']],
  ['LK', ['sri lanka', 'sri lankan', 'سريلانكا', 'سريلانكي']],
  ['ID', ['indonesia', 'indonesian', 'إندونيسيا', 'اندونيسي']],
  ['ET', ['ethiopia', 'ethiopian', 'إثيوبيا', 'اثيوبي']],
  ['KE', ['kenya', 'kenyan', 'كينيا', 'كيني']],
  ['UG', ['uganda', 'ugandan', 'أوغندا', 'اوغندي']],
  ['JO', ['jordan', 'jordanian', 'الأردن', 'اردني']],
  ['SY', ['syria', 'syrian', 'سوريا', 'سوري']],
  ['AF', ['afghanistan', 'afghan', 'أفغانستان', 'افغاني']],
  ['NG', ['nigeria', 'nigerian', 'نيجيريا', 'نيجيري']],
  ['MM', ['myanmar', 'burmese', 'ميانمار', 'بورمي']],
  ['MA', ['morocco', 'moroccan', 'المغرب', 'مغربي']],
  ['TN', ['tunisia', 'tunisian', 'تونس', 'تونسي']],
  ['LB', ['lebanon', 'lebanese', 'لبنان', 'لبناني']],
];
const NATIONALITY_MAP = new Map<string, string>();
for (const [code, names] of NATIONALITIES) for (const n of names) NATIONALITY_MAP.set(simplify(n), code);

/** A 2-letter country code, or a country name we know. Unknown names give a warning and are left empty. */
export function nationality(raw: unknown): Check<string | undefined> {
  const t = text(raw);
  if (!t) return ok(undefined);
  if (/^[A-Za-z]{2}$/.test(t)) return ok(t.toUpperCase());
  const code = NATIONALITY_MAP.get(simplify(t));
  return code ? ok(code) : ok(undefined, `Nationality "${t}" was not recognised and was left empty. Use a 2-letter code such as PK`);
}

// ---------------------------------------------------------------------
// Short texts
// ---------------------------------------------------------------------

export function requiredText(raw: unknown, label: string, min: number, max: number): Check<string> {
  const t = text(raw);
  if (!t) return fail(`${label} is empty`);
  if (t.length < min) return fail(`${label} is too short`);
  if (t.length > max) return fail(`${label} is too long (at most ${max} characters)`);
  return ok(t);
}

export function optionalText(raw: unknown, label: string, max: number): Check<string | undefined> {
  const t = text(raw);
  if (!t) return ok(undefined);
  return t.length > max ? fail(`${label} is too long (at most ${max} characters)`) : ok(t);
}

/** Debtor and debt references typed by the client, e.g. an employee number or invoice number. */
export function reference(raw: unknown, label: string): Check<string | undefined> {
  const t = text(raw);
  if (!t) return ok(undefined);
  const s = latinDigits(t).replace(/\s+/g, '');
  return /^[A-Za-z0-9][A-Za-z0-9\-_/.]{0,49}$/.test(s)
    ? ok(s)
    : fail(`${label} "${t}" can only use letters, digits and - _ / . (at most 50)`);
}

/** Reference numbers on instruments (Nafith number, cheque number): compared without spaces, in upper case. */
export function instrumentReference(raw: unknown): Check<string | undefined> {
  const t = text(raw);
  if (!t) return ok(undefined);
  const s = latinDigits(t).trim();
  return s.length > 60 ? fail('Instrument reference number is too long (at most 60 characters)') : ok(s);
}

export const sameReference = (a: string, b: string) =>
  a.replace(/\s+/g, '').toUpperCase() === b.replace(/\s+/g, '').toUpperCase();
