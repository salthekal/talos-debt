/**
 * Reading a legal case: every legal debt with where it stands, and everything
 * Najiz will receive for one debt. Used by the routes, the filing pack and the
 * Najiz robot, so they all see the same case.
 */
import type { Db } from '../db.js';
import { missingForNajiz, type NajizField } from './readiness.js';

export const OPEN_CASE = `l.status NOT IN ('closed','withdrawn','settled')`;

export interface LegalRowDb {
  debt_id: string; debtor_id: string; full_name: string; ref_code: string;
  amount_outstanding: string; amount_original: string; debt_status: string; legal_ready_at: string;
  instrument_type: string | null; instrument_id: string | null;
  owner_id_number: string | null; unified_number: string | null; iban: string | null; bank_name: string | null; cr_mime: string | null;
  first_name: string | null; family_name: string | null; id_type: string; id_number: string | null; nationality: string | null;
  note_mime: string | null; issue_city: string | null; issue_date: string | null; due_date: string | null; due_on_demand: boolean | null;
  case_id: string | null; case_status: string | null; najiz_request_number: string | null; najiz_status: string | null;
  najiz_circuit: string | null; submitted_at: string | null; najiz_status_checked_at: string | null;
}

/** Every legal debt, or one. A debt counts once it is ready for legal, in legal, or has a case. */
export async function loadRows(db: Db, debtId?: string): Promise<LegalRowDb[]> {
  const { rows } = await db.query<LegalRowDb>(
    `SELECT d.id AS debt_id, d.debtor_id, dr.full_name, d.ref_code, d.amount_outstanding, d.amount_original,
            d.status AS debt_status, d.status_changed_at AS legal_ready_at,
            i.type_code AS instrument_type, i.id AS instrument_id,
            c.owner_id_number, c.unified_number, c.iban, c.bank_name,
            (SELECT x.mime_type FROM app.documents x
              WHERE x.debtor_id IS NULL AND x.doc_type = 'cr'
              ORDER BY (x.mime_type = 'application/pdf') DESC, x.created_at DESC LIMIT 1) AS cr_mime,
            dr.first_name, dr.family_name, dr.id_type, dr.id_number, dr.nationality,
            (SELECT x.mime_type FROM app.documents x
              WHERE x.doc_type = 'promissory_note' AND (x.debt_id = d.id OR (i.id IS NOT NULL AND x.instrument_id = i.id))
              ORDER BY (x.mime_type = 'application/pdf') DESC, x.created_at DESC LIMIT 1) AS note_mime,
            i.issue_city, i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.due_on_demand,
            lc.id AS case_id, lc.status AS case_status, lc.najiz_request_number, lc.najiz_status, lc.najiz_circuit,
            lc.submitted_at, lc.najiz_status_checked_at
       FROM app.debts d
       JOIN app.debtors dr ON dr.id = d.debtor_id
       JOIN app.clients c ON c.id = d.client_id
       LEFT JOIN app.instruments i ON i.id = d.instrument_id
       LEFT JOIN LATERAL (
         SELECT l.* FROM app.legal_cases l WHERE l.debt_id = d.id
          ORDER BY (${OPEN_CASE}) DESC, l.created_at DESC LIMIT 1
       ) lc ON true
      WHERE (d.status IN ('legal_ready', 'in_legal') OR lc.id IS NOT NULL)
        AND ($1::uuid IS NULL OR d.id = $1::uuid)
      ORDER BY d.status_changed_at, d.ref_code`,
    [debtId ?? null],
  );
  return rows;
}

export function missingOf(r: LegalRowDb): NajizField[] {
  return missingForNajiz({
    owner_id_number: r.owner_id_number, unified_number: r.unified_number, iban: r.iban, bank_name: r.bank_name, cr_mime: r.cr_mime,
    debtor_first_name: r.first_name, debtor_family_name: r.family_name, debtor_id_type: r.id_type, debtor_id_number: r.id_number,
    debtor_nationality: r.nationality, instrument_type: r.instrument_type, note_mime: r.note_mime,
    issue_city: r.issue_city, issue_date: r.issue_date, due_date: r.due_date, due_on_demand: r.due_on_demand,
  });
}

export function toRow(r: LegalRowDb) {
  const missing = missingOf(r);
  const before = !r.case_status || r.case_status === 'ready';
  const stage = before ? (missing.length ? 'missing' : 'to_approve') : r.case_status;
  return {
    debt_id: r.debt_id, debtor_id: r.debtor_id, full_name: r.full_name, ref_code: r.ref_code,
    amount_outstanding: r.amount_outstanding, instrument_type: r.instrument_type ?? 'none',
    case_id: r.case_id, stage, missing,
    najiz_request_number: r.najiz_request_number, najiz_status: r.najiz_status, najiz_circuit: r.najiz_circuit,
    submitted_at: r.submitted_at, najiz_status_checked_at: r.najiz_status_checked_at, legal_ready_at: r.legal_ready_at,
  };
}

export async function loadDetail(db: Db, debtId: string) {
  const [r] = await loadRows(db, debtId);
  if (!r) return undefined;
  const extra = await db.query(
    `SELECT c.legal_name, c.owner_name, c.owner_id_type, right(c.owner_id_number, 4) AS owner_id_last4,
            c.owner_email, c.owner_phone,
            dr.father_name, dr.grandfather_name,
            (SELECT p.phone_e164 FROM app.debtor_phones p
              WHERE p.debtor_id = dr.id AND p.status = 'active' ORDER BY p.is_primary DESC, p.created_at LIMIT 1) AS phone,
            i.reference_number, i.face_amount, i.issue_country,
            -- What is claimed is what is left; what was received is the note's amount minus that.
            coalesce(lc.amount_claimed, d.amount_outstanding) AS claimed,
            coalesce(lc.amount_received, greatest(coalesce(i.face_amount, d.amount_original) - d.amount_outstanding, 0)) AS received,
            lc.approved_at, lc.contact_email, lc.contact_phone, u.full_name AS approved_by_name
       FROM app.debts d
       JOIN app.debtors dr ON dr.id = d.debtor_id
       JOIN app.clients c ON c.id = d.client_id
       LEFT JOIN app.instruments i ON i.id = d.instrument_id
       LEFT JOIN app.legal_cases lc ON lc.id = $2
       LEFT JOIN app.users u ON u.id = lc.approved_by
      WHERE d.id = $1`,
    [debtId, r.case_id],
  );
  const x = extra.rows[0];
  const files = await db.query(
    `SELECT DISTINCT ON (kind) kind, id, debtor_id, debt_id, doc_type, file_name, mime_type, size_bytes, source, created_at
       FROM (SELECT CASE WHEN doc_type = 'promissory_note' THEN 'promissory_note' ELSE doc_type END AS kind, *
               FROM app.documents
              WHERE (debtor_id IS NULL AND doc_type IN ('cr', 'establishment_contract', 'partners_decision'))
                 OR (doc_type = 'promissory_note' AND (debt_id = $1 OR ($2::uuid IS NOT NULL AND instrument_id = $2::uuid)))) f
      ORDER BY kind, (mime_type = 'application/pdf') DESC, created_at DESC`,
    [debtId, r.instrument_id],
  );
  const file = (kind: string) => {
    const f = files.rows.find((y) => y.kind === kind);
    if (!f) return null;
    const { kind: _k, ...doc } = f;
    return doc;
  };
  const pack = (await db.query(
    `SELECT id, debtor_id, debt_id, doc_type, file_name, mime_type, size_bytes, source, created_at
       FROM app.documents WHERE doc_type = 'legal_pack' AND debt_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [debtId],
  )).rows[0] ?? null;
  const events = r.case_id
    ? (await db.query(
        `SELECT e.id, e.status, e.najiz_status, e.note, e.source, u.full_name AS recorded_by_name, e.recorded_at
           FROM app.legal_case_events e LEFT JOIN app.users u ON u.id = e.recorded_by
          WHERE e.legal_case_id = $1 ORDER BY e.recorded_at DESC, e.id`,
        [r.case_id],
      )).rows
    : [];
  return {
    row: toRow(r),
    company: {
      legal_name: x.legal_name, unified_number: r.unified_number, owner_name: x.owner_name, owner_id_type: x.owner_id_type,
      owner_id_last4: x.owner_id_last4, owner_email: x.owner_email, owner_phone: x.owner_phone, bank_name: r.bank_name, iban: r.iban,
    },
    debtor: {
      full_name: r.full_name, id_type: r.id_type, id_number: r.id_number, nationality: r.nationality,
      first_name: r.first_name, father_name: x.father_name, grandfather_name: x.grandfather_name, family_name: r.family_name, phone: x.phone,
    },
    note: {
      type: r.instrument_type ?? 'none', reference_number: x.reference_number, issue_date: r.issue_date, due_date: r.due_date,
      due_on_demand: r.due_on_demand ?? false, issue_country: x.issue_country, issue_city: r.issue_city, face_amount: x.face_amount,
    },
    amounts: { claimed: x.claimed, received: x.received },
    files: {
      cr: file('cr'), establishment_contract: file('establishment_contract'), partners_decision: file('partners_decision'),
      promissory_note: file('promissory_note'),
    },
    approval: x.approved_at
      ? { approved_by_name: x.approved_by_name, approved_at: x.approved_at, contact_email: x.contact_email, contact_phone: x.contact_phone }
      : null,
    /** The latest filing pack (5.1), if one was made. */
    pack,
    events,
  };
}


export type LegalCaseDetail = NonNullable<Awaited<ReturnType<typeof loadDetail>>>;
