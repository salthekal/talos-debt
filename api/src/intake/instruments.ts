/**
 * Linking debts to instruments. Several debts of one debtor can rest on the
 * same instrument (for example one promissory note signed at hiring), so
 * instruments are matched by debtor + type + reference number: the same
 * note given twice becomes one record.
 */
import type { Db } from '../db.js';
import { sameReference } from './normalize.js';
import type { InstrumentFields } from './records.js';
import { findInstrument, newId, type NewInstrument } from './write.js';

export type InstrumentPick = { kind: 'existing'; id: string } | { kind: 'new'; record: NewInstrument };

/** Within one batch: instruments without a reference number are never shared. */
export function instrumentKey(debtorKey: string, f: InstrumentFields): string | undefined {
  return f.reference_number ? `${debtorKey}|${f.type_code}|${f.reference_number.replace(/\s+/g, '').toUpperCase()}` : undefined;
}

/** Two descriptions of the same instrument must agree on dates and amount. */
export function instrumentConflict(a: InstrumentFields, b: InstrumentFields): string | undefined {
  if (a.issue_date && b.issue_date && a.issue_date !== b.issue_date) return `issue date ${a.issue_date} vs ${b.issue_date}`;
  if (a.due_date && b.due_date && a.due_date !== b.due_date) return `due date ${a.due_date} vs ${b.due_date}`;
  if (a.face_amount && b.face_amount && a.face_amount !== b.face_amount) return `amount ${a.face_amount} vs ${b.face_amount}`;
  return undefined;
}

/** Fill empty fields of a from b (both describe the same instrument). */
export function mergeInstrument(a: InstrumentFields, b: InstrumentFields): InstrumentFields {
  return {
    type_code: a.type_code,
    reference_number: a.reference_number ?? b.reference_number,
    issue_date: a.issue_date ?? b.issue_date,
    due_date: a.due_date ?? b.due_date,
    face_amount: a.face_amount ?? b.face_amount,
  };
}

/** For one debtor already in the database: reuse a stored instrument with the same reference, or make a new one. */
export async function pickInstrument(db: Db, debtorId: string, f: InstrumentFields): Promise<InstrumentPick> {
  if (f.reference_number) {
    const found = await findInstrument(db, debtorId, f.type_code, f.reference_number);
    if (found) return { kind: 'existing', id: found.id };
  }
  return { kind: 'new', record: { ...f, id: newId(), debtor_id: debtorId } };
}

export { sameReference };
