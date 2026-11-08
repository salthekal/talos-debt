/**
 * Database writes for new debtors, phones, instruments and debts. Manual
 * entry and the Excel import both use these, always inside withTenant, so
 * Row Level Security and the audit log apply the same way to both.
 *
 * Each function writes a whole list in one statement (an import can have
 * thousands of rows). Ids are made here, so callers can link records before
 * they are saved. Records without a reference get one from app.next_ref;
 * records with a typed reference are saved first, so a generated number
 * never takes a number someone typed in the same batch.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { DebtFields, DebtorFields, InstrumentFields } from './records.js';

export const newId = () => randomUUID();

export interface NewDebtor extends DebtorFields {
  id: string;
}
export interface NewPhone {
  debtor_id: string;
  phone_e164: string;
  is_primary: boolean;
  label?: string | null;
}
export interface NewInstrument extends InstrumentFields {
  id: string;
  debtor_id: string;
}
export interface NewDebt extends DebtFields {
  id: string;
  debtor_id: string;
  instrument_id: string | null;
  import_id?: string | null;
}

/** Typed references first, then generated ones (see the note at the top). */
const typedFirst = <T extends { ref_code: string | null }>(list: T[]) => [
  list.filter((x) => x.ref_code),
  list.filter((x) => !x.ref_code),
];

export async function insertDebtors(db: Db, list: NewDebtor[]): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for (const part of typedFirst(list)) {
    if (!part.length) continue;
    const { rows } = await db.query<{ id: string; ref_code: string }>(
      `INSERT INTO app.debtors (id, client_id, ref_code, debtor_kind, id_type, id_number, full_name, full_name_ar,
                                nationality, preferred_language, national_address, employment_status, notes)
       SELECT r.id, app.current_client_id(), coalesce(r.ref_code, app.next_ref('debtor')), r.debtor_kind, r.id_type,
              r.id_number, r.full_name, r.full_name_ar, r.nationality, r.preferred_language, r.national_address,
              r.employment_status, r.notes
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, ref_code text, debtor_kind text, id_type text, id_number text,
              full_name text, full_name_ar text, nationality text, preferred_language text, national_address text,
              employment_status text, notes text)
       RETURNING id, ref_code`,
      [JSON.stringify(part)],
    );
    for (const r of rows) refs.set(r.id, r.ref_code);
  }
  return refs;
}

/**
 * Phones already stored for the debtor are skipped. A phone is made primary
 * only if the debtor has no primary phone yet.
 */
export async function insertPhones(db: Db, list: NewPhone[]): Promise<number> {
  if (!list.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO app.debtor_phones (client_id, debtor_id, phone_e164, label, is_primary)
     SELECT app.current_client_id(), r.debtor_id, r.phone_e164, r.label,
            r.is_primary AND NOT EXISTS (SELECT 1 FROM app.debtor_phones p WHERE p.debtor_id = r.debtor_id AND p.is_primary)
       FROM jsonb_to_recordset($1::jsonb) AS r(debtor_id uuid, phone_e164 text, label text, is_primary boolean)
     ON CONFLICT (client_id, debtor_id, phone_e164) DO NOTHING`,
    [JSON.stringify(list)],
  );
  return rowCount ?? 0;
}

export async function insertInstruments(db: Db, list: NewInstrument[]): Promise<void> {
  if (!list.length) return;
  await db.query(
    `INSERT INTO app.instruments (id, client_id, debtor_id, type_code, reference_number, issue_date, due_date, face_amount)
     SELECT r.id, app.current_client_id(), r.debtor_id, r.type_code, r.reference_number, r.issue_date, r.due_date, r.face_amount
       FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, debtor_id uuid, type_code text, reference_number text,
            issue_date date, due_date date, face_amount numeric)`,
    [JSON.stringify(list)],
  );
}

export async function insertDebts(db: Db, list: NewDebt[], createdBy: string | null): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  for (const part of typedFirst(list)) {
    if (!part.length) continue;
    const { rows } = await db.query<{ id: string; ref_code: string }>(
      `INSERT INTO app.debts (id, client_id, debtor_id, instrument_id, ref_code, amount_original, amount_outstanding,
                              reason, reason_category, issue_date, due_date, import_id, created_by)
       SELECT r.id, app.current_client_id(), r.debtor_id, r.instrument_id, coalesce(r.ref_code, app.next_ref('debt')),
              r.amount_original, r.amount_original, r.reason, r.reason_category, r.issue_date, r.due_date, r.import_id, $2
         FROM jsonb_to_recordset($1::jsonb) AS r(id uuid, debtor_id uuid, instrument_id uuid, ref_code text,
              amount_original numeric, reason text, reason_category text, issue_date date, due_date date, import_id uuid)
       RETURNING id, ref_code`,
      [JSON.stringify(part), createdBy],
    );
    for (const r of rows) refs.set(r.id, r.ref_code);
  }
  return refs;
}

/** Find an instrument already stored for this debtor with the same type and reference number. */
export async function findInstrument(
  db: Db,
  debtorId: string,
  typeCode: string,
  referenceNumber: string,
): Promise<{ id: string } | undefined> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM app.instruments
      WHERE debtor_id = $1 AND type_code = $2
        AND upper(replace(reference_number, ' ', '')) = upper(replace($3, ' ', ''))`,
    [debtorId, typeCode, referenceNumber],
  );
  return rows[0];
}

/** Turn a unique-key error into a message for the user, or undefined for other errors. */
export function duplicateMessage(err: unknown): { field: string; message: string } | undefined {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return undefined;
  switch (e.constraint) {
    case 'debtors_client_id_id_type_id_number_key':
      return { field: 'id_number', message: 'A debtor with this ID number already exists' };
    case 'debtors_client_id_ref_code_key':
      return { field: 'ref_code', message: 'This debtor reference is already used' };
    case 'debts_client_id_ref_code_key':
      return { field: 'ref_code', message: 'This debt reference is already used' };
    case 'debtor_phones_client_id_debtor_id_phone_e164_key':
      return { field: 'phone', message: 'This debtor already has this phone number' };
    case 'instruments_one_per_reference':
      return { field: 'reference_number', message: 'This debtor already has an instrument of this type with this reference number' };
    default:
      return { field: 'input', message: 'This record already exists' };
  }
}
