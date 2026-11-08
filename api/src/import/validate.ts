/**
 * Checking an Excel import and turning it into a save plan.
 *
 * 1. Every row: the same checks as manual entry (intake/records.ts).
 * 2. Rows with the same ID number become one debtor:
 *    - a different name on a later row is an error,
 *    - other details missing on the first row are taken from later rows,
 *      different values give a warning and the first row wins,
 *    - phones from all rows are joined.
 * 3. Rows of one debtor with the same instrument type and number share one
 *    instrument; different dates or amounts for it are an error.
 * 4. Against the database:
 *    - debtors already stored keep their details; new debts and phones are added,
 *    - debt references and debtor references already used are errors,
 *    - instruments already stored for the debtor are reused.
 *
 * Any error means nothing is saved (all or nothing). Warnings never block.
 */
import type { Db } from '../db.js';
import { instrumentConflict, mergeInstrument } from '../intake/instruments.js';
import { isBlank, simplify } from '../intake/normalize.js';
import {
  checkDebt,
  checkDebtor,
  checkInstrument,
  checkPhones,
  loadInstrumentTypes,
  type DebtFields,
  type DebtorFields,
  type InstrumentFields,
  type Issue,
} from '../intake/records.js';
import { newId, type NewDebt, type NewDebtor, type NewInstrument, type NewPhone } from '../intake/write.js';
import { COLUMNS } from './columns.js';
import type { ParsedSheet, RawRow } from './parse.js';

export interface ReportIssue {
  /** Excel row number; null for the whole file. */
  row: number | null;
  /** Column header in English, e.g. "Phone 1". */
  column: string | null;
  /** Excel cell, e.g. "H5". */
  cell: string | null;
  message: string;
}

export interface ImportSummary {
  rows: number;
  rows_with_errors: number;
  debtors_new: number;
  debtors_existing: number;
  debts: number;
  total_amount: string;
  enforceable_amount: string;
  instruments_new: number;
  instruments_reused: number;
  phones_new: number;
}

export interface ImportPlan {
  debtors: NewDebtor[];
  phones: NewPhone[];
  instruments: NewInstrument[];
  debts: NewDebt[];
}

export interface ImportCheck {
  errors: ReportIssue[];
  warnings: ReportIssue[];
  summary: ImportSummary;
  plan?: ImportPlan;
}

/** Stored reports are cut at this many lines each; the counts stay exact. */
export const MAX_REPORT_LINES = 1000;

const columnName = new Map(COLUMNS.map((c) => [c.key, c.en]));

/** Which template column a checker field came from. */
function columnOf(field: string, part: 'debtor' | 'debt' | 'instrument' | 'phones'): string {
  const phone = /^phones\[(\d+)\]$/.exec(field);
  if (phone) return `phone_${Number(phone[1]) + 1}`;
  if (field === 'ref_code') return part === 'debtor' ? 'debtor_ref' : 'debt_ref';
  return field;
}

interface RowData {
  row: number;
  raw: RawRow['cells'];
  debtor: DebtorFields;
  phones: string[];
  debt: DebtFields;
  instrument: InstrumentFields | null;
}

interface Group {
  key: string;
  firstRow: number;
  debtor: DebtorFields;
  /** Which debtor fields the client actually filled in (the others are defaults). */
  given: Set<string>;
  phones: string[];
  rows: RowData[];
  existing?: { id: string; ref_code: string; full_name: string };
}

const MERGED_FIELDS: { field: keyof DebtorFields; column: string }[] = [
  { field: 'full_name_ar', column: 'full_name_ar' },
  { field: 'nationality', column: 'nationality' },
  { field: 'preferred_language', column: 'preferred_language' },
  { field: 'employment_status', column: 'employment_status' },
  { field: 'debtor_kind', column: 'debtor_kind' },
  { field: 'notes', column: 'notes' },
];

const cents = (a: string) => BigInt(a.replace('.', ''));
const fromCents = (c: bigint) => {
  const s = c.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
};

export async function checkImport(db: Db, sheet: ParsedSheet, importId: string | null): Promise<ImportCheck> {
  const errors: ReportIssue[] = [];
  const warnings: ReportIssue[] = [];
  const rowsWithErrors = new Set<number>();
  const types = await loadInstrumentTypes(db);
  const enforceable = new Set(types.filter((t) => t.directly_enforceable).map((t) => t.code));

  const at = (row: number | null, key: string | null, message: string): ReportIssue => ({
    row,
    column: key ? (columnName.get(key) ?? key) : null,
    cell: row && key && sheet.columns[key] ? `${sheet.columns[key]}${row}` : null,
    message,
  });
  const error = (row: number, key: string | null, message: string) => {
    errors.push(at(row, key, message));
    rowsWithErrors.add(row);
  };
  const warn = (row: number, key: string | null, message: string) => warnings.push(at(row, key, message));
  const addIssues = (row: number, issues: Issue[], part: 'debtor' | 'debt' | 'instrument' | 'phones', kind: 'error' | 'warn') =>
    issues.forEach((i) => (kind === 'error' ? error : warn)(row, columnOf(i.field, part), i.message));

  // ---- 1. Each row on its own ----
  const valid: RowData[] = [];
  for (const { row, cells } of sheet.rows) {
    const debtor = checkDebtor(
      {
        id_type: cells.id_type, id_number: cells.id_number, full_name: cells.full_name, full_name_ar: cells.full_name_ar,
        debtor_kind: cells.debtor_kind, nationality: cells.nationality, preferred_language: cells.preferred_language,
        employment_status: cells.employment_status, ref_code: cells.debtor_ref, notes: cells.notes, national_address: null,
      },
      'create',
    );
    const phoneCells = [cells.phone_1, cells.phone_2, cells.phone_3];
    const phones = checkPhones(phoneCells);
    const debt = checkDebt(
      { ref_code: cells.debt_ref, amount: cells.amount, reason: cells.reason, reason_category: cells.reason_category,
        issue_date: cells.issue_date, due_date: cells.due_date },
      'create',
    );
    const inst = checkInstrument(
      { type: cells.instrument_type, reference_number: cells.instrument_reference, issue_date: cells.instrument_issue_date,
        face_amount: cells.instrument_amount, due_date: null },
      types,
    );
    addIssues(row, debtor.errors, 'debtor', 'error');
    addIssues(row, debtor.warnings, 'debtor', 'warn');
    addIssues(row, phones.errors, 'phones', 'error');
    addIssues(row, phones.warnings, 'phones', 'warn');
    if (phoneCells.every(isBlank)) error(row, 'phone_1', 'Phone 1 is empty: give at least one phone number');
    addIssues(row, debt.errors, 'debt', 'error');
    addIssues(row, debt.warnings, 'debt', 'warn');
    addIssues(row, inst.errors, 'instrument', 'error');
    addIssues(row, inst.warnings, 'instrument', 'warn');
    // Rows whose debtor is readable still take part in the checks below, so one
    // upload shows as many problems as possible.
    const d = debtor.value as DebtorFields;
    if (d.id_type && d.id_number && d.full_name) {
      valid.push({
        row, raw: cells, debtor: d, phones: phones.value,
        debt: debt.value as DebtFields, instrument: (inst.value as InstrumentFields | null) ?? null,
      });
    }
  }

  // ---- 2. Rows of the same debtor ----
  const groups = new Map<string, Group>();
  for (const r of valid) {
    const key = `${r.debtor.id_type}:${r.debtor.id_number}`;
    const g = groups.get(key);
    if (!g) {
      const given = new Set(MERGED_FIELDS.filter((f) => !isBlank(r.raw[f.column])).map((f) => f.field as string));
      if (!isBlank(r.raw.debtor_ref)) given.add('ref_code');
      groups.set(key, { key, firstRow: r.row, debtor: { ...r.debtor }, given, phones: [...r.phones], rows: [r] });
      continue;
    }
    g.rows.push(r);
    if (simplify(r.debtor.full_name) !== simplify(g.debtor.full_name)) {
      error(r.row, 'full_name', `Same ID number as row ${g.firstRow} but a different name ("${g.debtor.full_name}" and "${r.debtor.full_name}")`);
    }
    if (!isBlank(r.raw.debtor_ref)) {
      if (!g.given.has('ref_code')) {
        g.debtor.ref_code = r.debtor.ref_code;
        g.given.add('ref_code');
      } else if (g.debtor.ref_code !== r.debtor.ref_code) {
        error(r.row, 'debtor_ref', `Same debtor as row ${g.firstRow} but a different employee or customer number (${g.debtor.ref_code} and ${r.debtor.ref_code})`);
      }
    }
    for (const f of MERGED_FIELDS) {
      if (isBlank(r.raw[f.column])) continue;
      const mine = r.debtor[f.field];
      if (!g.given.has(f.field)) {
        (g.debtor as unknown as Record<string, unknown>)[f.field] = mine;
        g.given.add(f.field);
      } else if (g.debtor[f.field] !== mine) {
        warn(r.row, f.column, `Different from row ${g.firstRow} for the same debtor ("${g.debtor[f.field]}" and "${mine}"). The first value is used`);
      }
    }
    for (const p of r.phones) if (!g.phones.includes(p)) g.phones.push(p);
  }

  // The same employee number on two different debtors.
  const debtorRefs = new Map<string, Group>();
  for (const g of groups.values()) {
    const ref = g.debtor.ref_code;
    if (!ref) continue;
    const other = debtorRefs.get(ref.toUpperCase());
    if (other) error(g.firstRow, 'debtor_ref', `Employee or customer number ${ref} is also used for another debtor (row ${other.firstRow})`);
    else debtorRefs.set(ref.toUpperCase(), g);
  }

  // The same phone given for two different debtors (allowed: shared family phones exist).
  const phoneOwner = new Map<string, Group>();
  for (const g of groups.values()) {
    for (const p of g.phones) {
      const other = phoneOwner.get(p);
      if (other && other !== g) warn(g.firstRow, 'phone_1', `Phone ${p} is also given for another debtor (row ${other.firstRow})`);
      else phoneOwner.set(p, g);
    }
  }

  // ---- Debts across the file ----
  const debtRefs = new Map<string, number>();
  const lookalikes = new Map<string, number>();
  for (const g of groups.values()) {
    for (const r of g.rows) {
      const ref = r.debt.ref_code;
      if (ref) {
        const first = debtRefs.get(ref.toUpperCase());
        if (first) error(r.row, 'debt_ref', `Debt reference ${ref} is already used in row ${first}`);
        else debtRefs.set(ref.toUpperCase(), r.row);
      }
      if (r.debt.amount_original && r.debt.reason) {
        const look = `${g.key}|${r.debt.amount_original}|${simplify(r.debt.reason)}|${r.debt.issue_date ?? ''}`;
        const first = lookalikes.get(look);
        if (first) warn(r.row, 'amount', `Looks the same as row ${first} (same debtor, amount, reason and date). Delete it if it is a copy`);
        else lookalikes.set(look, r.row);
      }
    }
  }

  // ---- 3. Instruments shared by several rows ----
  type InstrumentSlot = { id: string; fields: InstrumentFields; firstRow: number; existing: boolean; debtorKey: string };
  const slots = new Map<string, InstrumentSlot>();
  const rowInstrument = new Map<number, InstrumentSlot>();
  const crossDebtor = new Map<string, { row: number; debtorKey: string }>();
  for (const g of groups.values()) {
    for (const r of g.rows) {
      const inst = r.instrument;
      if (!inst?.type_code) continue;
      const refKey = inst.reference_number ? inst.reference_number.replace(/\s+/g, '').toUpperCase() : undefined;
      if (refKey) {
        const cross = crossDebtor.get(`${inst.type_code}|${refKey}`);
        if (cross && cross.debtorKey !== g.key) {
          warn(r.row, 'instrument_reference', `The same instrument number is also given in row ${cross.row} for a different debtor`);
        } else if (!cross) {
          crossDebtor.set(`${inst.type_code}|${refKey}`, { row: r.row, debtorKey: g.key });
        }
      }
      const slotKey = refKey ? `${g.key}|${inst.type_code}|${refKey}` : `row:${r.row}`;
      const slot = slots.get(slotKey);
      if (slot) {
        const conflict = instrumentConflict(slot.fields, inst);
        if (conflict) error(r.row, 'instrument_reference', `Same instrument as row ${slot.firstRow} but different details (${conflict})`);
        else slot.fields = mergeInstrument(slot.fields, inst);
        rowInstrument.set(r.row, slot);
      } else {
        const s = { id: newId(), fields: { ...inst }, firstRow: r.row, existing: false, debtorKey: g.key };
        slots.set(slotKey, s);
        rowInstrument.set(r.row, s);
      }
    }
  }

  // ---- 4. Against what is already stored ----
  const list = [...groups.values()];
  if (list.length) {
    const found = await db.query<{ id: string; ref_code: string; id_type: string; id_number: string; full_name: string }>(
      `SELECT d.id, d.ref_code, d.id_type, d.id_number, d.full_name
         FROM app.debtors d
         JOIN unnest($1::text[], $2::text[]) AS k(id_type, id_number)
           ON d.id_type = k.id_type AND d.id_number = k.id_number`,
      [list.map((g) => g.debtor.id_type), list.map((g) => g.debtor.id_number)],
    );
    for (const e of found.rows) {
      const g = groups.get(`${e.id_type}:${e.id_number}`)!;
      g.existing = { id: e.id, ref_code: e.ref_code, full_name: e.full_name };
      if (simplify(e.full_name) !== simplify(g.debtor.full_name)) {
        warn(g.firstRow, 'full_name', `Already in the system as ${e.ref_code} with the name "${e.full_name}". The stored details are kept; only the new debts and phones are added`);
      }
      if (g.given.has('ref_code') && g.debtor.ref_code !== e.ref_code) {
        warn(g.firstRow, 'debtor_ref', `Already in the system as ${e.ref_code}. That number is kept`);
      }
    }

    const newRefs = list.filter((g) => !g.existing && g.debtor.ref_code).map((g) => g.debtor.ref_code!);
    if (newRefs.length) {
      const taken = await db.query<{ ref_code: string }>(`SELECT ref_code FROM app.debtors WHERE ref_code = ANY($1::text[])`, [newRefs]);
      const takenSet = new Set(taken.rows.map((t) => t.ref_code));
      for (const g of list) {
        if (!g.existing && g.debtor.ref_code && takenSet.has(g.debtor.ref_code)) {
          error(g.firstRow, 'debtor_ref', `Employee or customer number ${g.debtor.ref_code} already belongs to another debtor in the system`);
        }
      }
    }

    const allDebtRefs = valid.map((r) => r.debt.ref_code).filter((x): x is string => !!x);
    if (allDebtRefs.length) {
      const taken = await db.query<{ ref_code: string }>(`SELECT ref_code FROM app.debts WHERE ref_code = ANY($1::text[])`, [allDebtRefs]);
      const takenSet = new Set(taken.rows.map((t) => t.ref_code));
      for (const r of valid) {
        if (r.debt.ref_code && takenSet.has(r.debt.ref_code)) {
          error(r.row, 'debt_ref', `Debt reference ${r.debt.ref_code} is already in the system`);
        }
      }
    }

    const existingIds = list.filter((g) => g.existing).map((g) => g.existing!.id);
    const storedPhones = new Map<string, Set<string>>();
    if (existingIds.length) {
      const insts = await db.query<{ id: string; debtor_id: string; type_code: string; ref_key: string }>(
        `SELECT id, debtor_id, type_code, upper(replace(reference_number, ' ', '')) AS ref_key
           FROM app.instruments WHERE debtor_id = ANY($1::uuid[]) AND reference_number IS NOT NULL`,
        [existingIds],
      );
      const byDebtor = new Map(list.filter((g) => g.existing).map((g) => [g.existing!.id, g.key]));
      for (const i of insts.rows) {
        const slot = slots.get(`${byDebtor.get(i.debtor_id)}|${i.type_code}|${i.ref_key}`);
        if (slot) {
          slot.id = i.id;
          slot.existing = true;
        }
      }
      const ph = await db.query<{ debtor_id: string; phone_e164: string }>(
        `SELECT debtor_id, phone_e164 FROM app.debtor_phones WHERE debtor_id = ANY($1::uuid[])`,
        [existingIds],
      );
      for (const p of ph.rows) {
        if (!storedPhones.has(p.debtor_id)) storedPhones.set(p.debtor_id, new Set());
        storedPhones.get(p.debtor_id)!.add(p.phone_e164);
      }
    }

    const allPhones = [...new Set(list.flatMap((g) => g.phones))];
    if (allPhones.length) {
      const others = await db.query<{ phone_e164: string; id_type: string; id_number: string; ref_code: string }>(
        `SELECT p.phone_e164, d.id_type, d.id_number, d.ref_code
           FROM app.debtor_phones p JOIN app.debtors d ON d.id = p.debtor_id
          WHERE p.phone_e164 = ANY($1::text[])`,
        [allPhones],
      );
      for (const o of others.rows) {
        const g = phoneOwner.get(o.phone_e164);
        if (g && g.key !== `${o.id_type}:${o.id_number}`) {
          warn(g.firstRow, 'phone_1', `Phone ${o.phone_e164} already belongs to debtor ${o.ref_code} in the system`);
        }
      }
    }

    // ---- Build the plan ----
    const plan: ImportPlan = { debtors: [], phones: [], instruments: [], debts: [] };
    let total = 0n;
    let enforceableTotal = 0n;
    const debtorIdOf = new Map<string, string>();
    for (const g of list) {
      const debtorId = g.existing?.id ?? newId();
      debtorIdOf.set(g.key, debtorId);
      if (!g.existing) plan.debtors.push({ ...g.debtor, id: debtorId });
      const stored = g.existing ? (storedPhones.get(g.existing.id) ?? new Set()) : new Set<string>();
      g.phones
        .filter((p) => !stored.has(p))
        .forEach((p, i) => plan.phones.push({ debtor_id: debtorId, phone_e164: p, is_primary: !g.existing && i === 0 }));
      for (const r of g.rows) {
        if (rowsWithErrors.has(r.row)) continue;
        const slot = rowInstrument.get(r.row);
        plan.debts.push({ ...r.debt, id: newId(), debtor_id: debtorId, instrument_id: slot?.id ?? null, import_id: importId });
        total += cents(r.debt.amount_original);
        if (slot && enforceable.has(slot.fields.type_code)) enforceableTotal += cents(r.debt.amount_original);
      }
    }
    for (const s of new Set(rowInstrument.values())) {
      if (!s.existing) plan.instruments.push({ ...s.fields, id: s.id, debtor_id: debtorIdOf.get(s.debtorKey)! });
    }

    const summary: ImportSummary = {
      rows: sheet.rows.length,
      rows_with_errors: 0,
      debtors_new: list.filter((g) => !g.existing).length,
      debtors_existing: list.filter((g) => g.existing).length,
      debts: plan.debts.length,
      total_amount: fromCents(total),
      enforceable_amount: fromCents(enforceableTotal),
      instruments_new: plan.instruments.length,
      instruments_reused: [...new Set(rowInstrument.values())].filter((s) => s.existing).length,
      phones_new: plan.phones.length,
    };
    summary.rows_with_errors = rowsWithErrors.size;
    return finish(errors, warnings, summary, rowsWithErrors.size ? undefined : plan);
  }

  for (const r of sheet.rows) rowsWithErrors.add(r.row);
  const summary: ImportSummary = {
    rows: sheet.rows.length, rows_with_errors: rowsWithErrors.size, debtors_new: 0, debtors_existing: 0, debts: 0,
    total_amount: '0.00', enforceable_amount: '0.00', instruments_new: 0, instruments_reused: 0, phones_new: 0,
  };
  return finish(errors, warnings, summary, undefined);
}

function finish(errors: ReportIssue[], warnings: ReportIssue[], summary: ImportSummary, plan?: ImportPlan): ImportCheck {
  const byRow = (a: ReportIssue, b: ReportIssue) => (a.row ?? 0) - (b.row ?? 0);
  errors.sort(byRow);
  warnings.sort(byRow);
  return { errors, warnings, summary, plan: errors.length ? undefined : plan };
}

/** Cut a long list for storing, with a last line that says how many more there are. */
export function capReport(list: ReportIssue[]): ReportIssue[] {
  if (list.length <= MAX_REPORT_LINES) return list;
  return [
    ...list.slice(0, MAX_REPORT_LINES),
    { row: null, column: null, cell: null, message: `...and ${list.length - MAX_REPORT_LINES} more` },
  ];
}
