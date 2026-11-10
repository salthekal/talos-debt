/**
 * What Najiz asks for when a promissory note is filed for execution, and
 * what is still missing for one debt (docs/najiz-filing.md). One set of rules,
 * used by the Legal list, the case page and the approval, so they always agree.
 */

export const NAJIZ_FIELDS = [
  'owner_id', 'unified_number', 'iban', 'cr_file', 'contract_file',
  'debtor_name', 'debtor_id', 'debtor_nationality',
  'note_type', 'note_file', 'note_place', 'note_date', 'note_due',
] as const;
export type NajizField = (typeof NAJIZ_FIELDS)[number];

/** Najiz takes PDF files only. */
export const PDF = 'application/pdf';

/** Instruments filed through this flow (Najiz: أوراق تجارية, سند لأمر). */
export const PROMISSORY_NOTES = ['nafith_promissory_note', 'paper_promissory_note'];

/** Debtor ID types Najiz accepts for a person. */
const PERSON_ID_TYPES = ['national_id', 'iqama', 'passport'];

export interface ReadinessFacts {
  owner_id_number: string | null;
  unified_number: string | null;
  iban: string | null;
  bank_name: string | null;
  cr_mime: string | null;
  debtor_first_name: string | null;
  debtor_family_name: string | null;
  debtor_id_type: string;
  debtor_id_number: string | null;
  debtor_nationality: string | null;
  instrument_type: string | null;
  note_mime: string | null;
  issue_city: string | null;
  issue_date: string | null;
  due_date: string | null;
  due_on_demand: boolean | null;
}

const has = (v: string | null | undefined) => !!v && v.trim() !== '';

/**
 * The details Najiz still needs, in the order Najiz asks for them. The
 * establishment contract is optional on Najiz, so it is never "missing".
 */
export function missingForNajiz(f: ReadinessFacts): NajizField[] {
  const out: NajizField[] = [];
  if (!has(f.owner_id_number)) out.push('owner_id');
  if (!has(f.unified_number)) out.push('unified_number');
  if (!has(f.iban) || !has(f.bank_name)) out.push('iban');
  if (f.cr_mime !== PDF) out.push('cr_file');
  if (!has(f.debtor_first_name) || !has(f.debtor_family_name)) out.push('debtor_name');
  if (!PERSON_ID_TYPES.includes(f.debtor_id_type) || !has(f.debtor_id_number)) out.push('debtor_id');
  if (!has(f.debtor_nationality)) out.push('debtor_nationality');
  if (!f.instrument_type || !PROMISSORY_NOTES.includes(f.instrument_type)) {
    // Without a promissory note there is nothing to file here; the other note details do not apply.
    out.push('note_type');
    return out;
  }
  if (f.note_mime !== PDF) out.push('note_file');
  if (!has(f.issue_city)) out.push('note_place');
  if (!has(f.issue_date)) out.push('note_date');
  if (!f.due_on_demand && !has(f.due_date)) out.push('note_due');
  return out;
}
