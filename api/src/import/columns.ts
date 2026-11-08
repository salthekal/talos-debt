/**
 * The columns of the Excel import template: one row per debt. Several rows
 * with the same ID number are the same debtor with several debts; each row
 * can have its own instrument (promissory note, cheque, none, ...). Rows
 * that give the same instrument type and number share one instrument.
 *
 * Headers are found by their English or Arabic name, so the client may
 * reorder columns or delete the optional ones.
 */
export type ListName = 'id_type' | 'language' | 'employment' | 'debtor_kind' | 'reason' | 'instrument';

export interface Column {
  key: string;
  en: string;
  ar: string;
  required?: boolean;
  format?: 'text' | 'date' | 'amount';
  list?: ListName;
  width: number;
  help: string;
}

export const COLUMNS: Column[] = [
  { key: 'id_type', en: 'ID type', ar: 'نوع الهوية', list: 'id_type', width: 18,
    help: 'National ID, Iqama, Passport, Commercial registration or Other. Can be left empty for Saudi IDs (start with 1) and iqamas (start with 2).' },
  { key: 'id_number', en: 'ID number', ar: 'رقم الهوية', required: true, format: 'text', width: 16,
    help: 'The same ID number on several rows means the same debtor with several debts.' },
  { key: 'full_name', en: 'Full name', ar: 'الاسم الكامل', required: true, width: 28,
    help: 'As on the ID. Must be the same on every row of the same debtor.' },
  { key: 'full_name_ar', en: 'Name in Arabic', ar: 'الاسم بالعربي', width: 24, help: 'Optional.' },
  { key: 'phone_1', en: 'Phone 1', ar: 'الجوال 1', required: true, format: 'text', width: 16,
    help: 'Saudi numbers as 05XXXXXXXX. Other countries with the country code, for example +923001234567.' },
  { key: 'phone_2', en: 'Phone 2', ar: 'الجوال 2', format: 'text', width: 16, help: 'Optional. Every number the debtor gave you.' },
  { key: 'phone_3', en: 'Phone 3', ar: 'الجوال 3', format: 'text', width: 16, help: 'Optional.' },
  { key: 'preferred_language', en: 'Language', ar: 'اللغة', list: 'language', width: 16,
    help: 'Language for the messages: Arabic, English, Urdu, Bengali or Hindi. Empty means Arabic.' },
  { key: 'nationality', en: 'Nationality', ar: 'الجنسية', width: 14, help: 'Optional. A country name or 2-letter code, for example PK.' },
  { key: 'employment_status', en: 'Still working?', ar: 'على رأس العمل؟', list: 'employment', width: 16,
    help: 'Is the debtor still working for you? Optional.' },
  { key: 'debtor_kind', en: 'Debtor type', ar: 'نوع المدين', list: 'debtor_kind', width: 14,
    help: 'Person or Company. Empty means Person (Company when the ID type is Commercial registration).' },
  { key: 'debtor_ref', en: 'Employee or customer number', ar: 'الرقم الوظيفي أو رقم العميل', format: 'text', width: 18,
    help: 'Optional. Your own number for this person. Empty: the system gives one (D-000123).' },
  { key: 'debt_ref', en: 'Debt reference', ar: 'مرجع الدين', format: 'text', width: 16,
    help: 'Optional. For example your invoice or deduction number. Must not repeat. Empty: the system gives one.' },
  { key: 'amount', en: 'Amount (SAR)', ar: 'المبلغ (ريال)', required: true, format: 'amount', width: 14,
    help: 'The amount still owed for this debt, in riyals. At most 2 decimals.' },
  { key: 'reason', en: 'Reason', ar: 'سبب الدين', required: true, width: 36,
    help: 'In your words. The debtor will see it, so be clear: for example "Motorcycle rent for August 2026".' },
  { key: 'reason_category', en: 'Reason type', ar: 'نوع السبب', list: 'reason', width: 22, help: 'Choose from the list. Empty means Other.' },
  { key: 'issue_date', en: 'Debt date', ar: 'تاريخ الدين', format: 'date', width: 13,
    help: 'Gregorian date, day/month/year. Optional.' },
  { key: 'due_date', en: 'Due date', ar: 'تاريخ الاستحقاق', format: 'date', width: 13, help: 'Gregorian date, day/month/year. Optional.' },
  { key: 'instrument_type', en: 'Instrument', ar: 'السند', list: 'instrument', width: 30,
    help: 'What the debtor signed for this debt: promissory note on Nafith, paper promissory note, cheque, judgment... Empty means none.' },
  { key: 'instrument_reference', en: 'Instrument number', ar: 'رقم السند', format: 'text', width: 18,
    help: 'Nafith number, cheque number or judgment number. Rows with the same instrument and number share one instrument.' },
  { key: 'instrument_issue_date', en: 'Instrument date', ar: 'تاريخ السند', format: 'date', width: 13, help: 'Optional.' },
  { key: 'instrument_amount', en: 'Instrument amount (SAR)', ar: 'مبلغ السند', format: 'amount', width: 14,
    help: 'Optional. The amount written on the note or cheque.' },
  { key: 'notes', en: 'Notes', ar: 'ملاحظات', width: 28, help: 'Optional. Internal notes about the debtor. The debtor does not see them.' },
];

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const DATA_SHEET = 'Debts';
