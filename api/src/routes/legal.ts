/**
 * Legal escalation (Phase 5): debts that reached the end of their reminders,
 * on their way to an execution request on Najiz.
 *
 *   GET   /api/legal                  every legal debt, where it stands, what Najiz still needs
 *   GET   /api/legal/:id              everything Najiz will receive for one debt (id = debt id)
 *   PATCH /api/legal/:id/details      fill in what is missing (debtor name, note place and due,
 *                                     company details for owners and admins)
 *   POST  /api/legal/:id/approve      the client approves the filing (5.2)
 *   POST  /api/legal/:id/status       a status entered by hand, for example a request number (5.3)
 *   POST  /api/najiz/runs             filing from Talos (5.4): not built yet, answers 501
 *
 * The database refuses a case past `ready` without approval, one open case per
 * debt and per note, and a request number before submitting (0001, 0008).
 * Every change to a case is written to the audit log by its trigger.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { EDITOR_ROLES, REVIEWER_ROLES, requireRole, tenantOf, type Role } from '../auth.js';
import { withTenant, type Db } from '../db.js';
import { idNumber, phone } from '../intake/normalize.js';
import { missingForNajiz, type NajizField } from '../legal/readiness.js';
import { idParam, parseOr400 } from '../validation.js';

/** Statuses staff may enter by hand after approval (5.3). */
const MANUAL_STATUSES = ['submitted', 'order_issued', 'measures_applied', 'settled', 'closed', 'withdrawn'] as const;
/** Statuses that mean the request is on Najiz, so the debt is "in legal". */
const ON_NAJIZ = ['submitted', 'order_issued', 'measures_applied'];
const OPEN_CASE = `l.status NOT IN ('closed','withdrawn','settled')`;
const COMPANY_ROLES: readonly Role[] = ['owner', 'admin'];

const name = z.string().trim().min(1).max(80);
const detailsBody = z
  .object({
    company: z.object({
      owner_id_type: z.enum(['national_id', 'iqama']),
      owner_id_number: z.string().max(20),
      unified_number: z.string().trim().regex(/^7[0-9]{9}$/, 'The unified number has 10 digits and starts with 7'),
    }).strict().optional(),
    debtor: z.object({
      first_name: name,
      father_name: name.optional(),
      grandfather_name: name.optional(),
      family_name: name,
    }).strict().optional(),
    note: z.object({
      issue_city: z.string().trim().min(2).max(60),
      due_on_demand: z.boolean(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-05-31').nullable().optional(),
    }).strict().refine((n) => n.due_on_demand || !!n.due_date, { message: 'Give the due date, or say the note is payable on demand', path: ['due_date'] })
      .optional(),
  })
  .strict()
  .refine((b) => b.company || b.debtor || b.note, { message: 'Nothing to save' });

const approveBody = z.object({
  contact_email: z.email('Write a full email address').max(200),
  contact_phone: z.string().max(30),
  pledge: z.literal(true, { error: 'The client must agree to the pledge' }),
}).strict();

const statusBody = z.object({
  status: z.enum(MANUAL_STATUSES),
  najiz_request_number: z.string().trim().regex(/^[0-9]{6,20}$/, 'The request number from Najiz has digits only').optional(),
  note: z.string().trim().max(1000).optional(),
}).strict();

// ------------------------------------------------------------------ reading

interface LegalRowDb {
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
async function loadRows(db: Db, debtId?: string): Promise<LegalRowDb[]> {
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

function missingOf(r: LegalRowDb): NajizField[] {
  return missingForNajiz({
    owner_id_number: r.owner_id_number, unified_number: r.unified_number, iban: r.iban, bank_name: r.bank_name, cr_mime: r.cr_mime,
    debtor_first_name: r.first_name, debtor_family_name: r.family_name, debtor_id_type: r.id_type, debtor_id_number: r.id_number,
    debtor_nationality: r.nationality, instrument_type: r.instrument_type, note_mime: r.note_mime,
    issue_city: r.issue_city, issue_date: r.issue_date, due_date: r.due_date, due_on_demand: r.due_on_demand,
  });
}

function toRow(r: LegalRowDb) {
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

async function loadDetail(db: Db, debtId: string) {
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
    events,
  };
}

const notFound = { error: 'not_found', message: 'No legal case for this debt' };

// ------------------------------------------------------------------ routes

export function legalRoutes(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/legal', async (req) => {
    const items = await withTenant(pool, tenantOf(req.user!), async (db) => (await loadRows(db)).map(toRow));
    return { items };
  });

  app.get('/api/legal/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const detail = await withTenant(pool, tenantOf(req.user!), (db) => loadDetail(db, p.id));
    if (!detail) return reply.code(404).send(notFound);
    return detail;
  });

  app.patch('/api/legal/:id/details', { preHandler: requireRole(EDITOR_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(detailsBody, req.body ?? {}, reply);
    if (!body) return;
    const user = req.user!;
    if (body.company && !COMPANY_ROLES.includes(user.role)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Only owners and admins change the company details' });
    }
    let ownerId: string | undefined;
    if (body.company) {
      const checked = idNumber(body.company.owner_id_type, body.company.owner_id_number);
      if (!checked.ok) return reply.code(400).send({ error: 'invalid', message: checked.error, errors: [{ field: 'owner_id_number', message: checked.error }] });
      const prefix = body.company.owner_id_type === 'national_id' ? '1' : '2';
      if (!/^[12][0-9]{9}$/.test(checked.value) || !checked.value.startsWith(prefix)) {
        const message = 'A national ID has 10 digits and starts with 1; an iqama starts with 2';
        return reply.code(400).send({ error: 'invalid', message, errors: [{ field: 'owner_id_number', message }] });
      }
      ownerId = checked.value;
    }

    const result = await withTenant(pool, tenantOf(user), async (db) => {
      const [r] = await loadRows(db, p.id);
      if (!r) return { code: 404 as const };
      if ((body.debtor || body.note) && r.case_status && r.case_status !== 'ready') {
        return { code: 409 as const, error: 'already_approved', message: 'This filing is approved, so its details can no longer change' };
      }
      if (body.note && !r.instrument_id) {
        return { code: 409 as const, error: 'no_instrument', message: 'This debt has no promissory note to describe' };
      }
      if (body.company) {
        await db.query(
          `UPDATE app.clients SET owner_id_type = $2, owner_id_number = $3, unified_number = $4 WHERE id = $1`,
          [user.clientId, body.company.owner_id_type, ownerId, body.company.unified_number],
        );
      }
      if (body.debtor) {
        const d = body.debtor;
        await db.query(
          `UPDATE app.debtors SET first_name = $2, father_name = $3, grandfather_name = $4, family_name = $5 WHERE id = $1`,
          [r.debtor_id, d.first_name, d.father_name ?? null, d.grandfather_name ?? null, d.family_name],
        );
      }
      if (body.note) {
        const n = body.note;
        await db.query(
          `UPDATE app.instruments
              SET issue_city = $2, issue_country = coalesce(issue_country, 'SA'), due_on_demand = $3,
                  due_date = CASE WHEN $3 THEN due_date ELSE $4::date END
            WHERE id = $1`,
          [r.instrument_id, n.issue_city, n.due_on_demand, n.due_on_demand ? null : n.due_date],
        );
      }
      return { code: 200 as const, detail: await loadDetail(db, p.id) };
    });
    if (result.code === 404) return reply.code(404).send(notFound);
    if (result.code === 409) return reply.code(409).send({ error: result.error, message: result.message });
    return result.detail;
  });

  app.post('/api/legal/:id/approve', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(approveBody, req.body ?? {}, reply);
    if (!body) return;
    const mobile = phone(body.contact_phone);
    if (!mobile.ok) {
      return reply.code(400).send({ error: 'invalid', message: mobile.error, errors: [{ field: 'contact_phone', message: mobile.error }] });
    }
    const user = req.user!;
    const result = await withTenant(pool, tenantOf(user), async (db) => {
      // Lock the debt, so two people approving at once cannot make two cases.
      const locked = await db.query(`SELECT id FROM app.debts WHERE id = $1 FOR UPDATE`, [p.id]);
      if (!locked.rows[0]) return { code: 404 as const };
      const [r] = await loadRows(db, p.id);
      if (!r) return { code: 404 as const };
      if (r.case_status && r.case_status !== 'ready') {
        return { code: 409 as const, error: 'already_approved', message: 'This filing is already approved' };
      }
      const missing = missingOf(r);
      if (missing.length) {
        return { code: 409 as const, error: 'najiz_details_missing', message: 'Fill in what Najiz needs before approving', missing };
      }
      if (!/[1-9]/.test(r.amount_outstanding)) {
        // Money stays text: no digit above zero means nothing is owed.
        return { code: 409 as const, error: 'nothing_owed', message: 'Nothing is left to claim on this debt' };
      }
      const values = [user.userId, body.contact_email.toLowerCase(), mobile.value];
      const saved = r.case_id
        ? await db.query<{ id: string }>(
            `UPDATE app.legal_cases l
                SET status = 'approved', approved_by = $1, approved_at = now(), contact_email = $2, contact_phone = $3,
                    amount_claimed = d.amount_outstanding,
                    amount_received = greatest(coalesce(i.face_amount, d.amount_original) - d.amount_outstanding, 0)
               FROM app.debts d LEFT JOIN app.instruments i ON i.id = d.instrument_id
              WHERE l.id = $4 AND d.id = l.debt_id AND l.status = 'ready'
              RETURNING l.id`,
            [...values, r.case_id],
          )
        : await db.query<{ id: string }>(
            `INSERT INTO app.legal_cases (client_id, debt_id, instrument_id, amount_claimed, amount_received,
                                          najiz_main_type, najiz_sub_type, court_name, status,
                                          approved_by, approved_at, contact_email, contact_phone)
             SELECT d.client_id, d.id, d.instrument_id, d.amount_outstanding,
                    greatest(coalesce(i.face_amount, d.amount_original) - d.amount_outstanding, 0),
                    'أوراق تجارية', 'سند لأمر', 'محكمة التنفيذ', 'approved', $1, now(), $2, $3
               FROM app.debts d LEFT JOIN app.instruments i ON i.id = d.instrument_id
              WHERE d.id = $4
             RETURNING id`,
            [...values, p.id],
          );
      const caseId = saved.rows[0]?.id;
      if (!caseId) return { code: 409 as const, error: 'already_approved', message: 'This filing is already approved' };
      await db.query(
        `INSERT INTO app.legal_case_events (client_id, legal_case_id, status, source, recorded_by)
         VALUES (app.current_client_id(), $1, 'approved', 'staff', $2)`,
        [caseId, user.userId],
      );
      return { code: 200 as const, detail: await loadDetail(db, p.id) };
    }).catch((err: { code?: string; constraint?: string }) => {
      // Another open request already uses this note (legal_cases_one_open_per_instrument).
      if (err.code === '23505') return { code: 409 as const, error: 'note_in_use', message: 'This note is already in another open request' };
      throw err;
    });
    if (result.code === 404) return reply.code(404).send(notFound);
    if (result.code === 409) {
      return reply.code(409).send({ error: result.error, message: result.message, ...('missing' in result ? { missing: result.missing } : {}) });
    }
    return result.detail;
  });

  app.post('/api/legal/:id/status', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(statusBody, req.body ?? {}, reply);
    if (!body) return;
    const user = req.user!;
    const result = await withTenant(pool, tenantOf(user), async (db) => {
      const [r] = await loadRows(db, p.id);
      if (!r) return { code: 404 as const };
      if (!r.case_id || (r.case_status === 'ready' && body.status !== 'withdrawn')) {
        return { code: 409 as const, error: 'not_approved', message: 'Approve the filing before adding a status' };
      }
      const number = body.najiz_request_number ?? r.najiz_request_number;
      if (body.status !== 'withdrawn' && !number) {
        return { code: 400 as const, error: 'invalid', message: 'Give the request number from Najiz', field: 'najiz_request_number' };
      }
      await db.query(
        `UPDATE app.legal_cases
            SET status = $2, najiz_request_number = coalesce($3, najiz_request_number),
                submitted_at = CASE WHEN $3 IS NOT NULL OR $2 = ANY($4::text[]) THEN coalesce(submitted_at, now()) ELSE submitted_at END
          WHERE id = $1`,
        [r.case_id, body.status, body.najiz_request_number ?? null, ON_NAJIZ],
      );
      await db.query(
        `INSERT INTO app.legal_case_events (client_id, legal_case_id, status, note, source, recorded_by)
         VALUES (app.current_client_id(), $1, $2, $3, 'staff', $4)`,
        [r.case_id, body.status, body.note ?? null, user.userId],
      );
      if (ON_NAJIZ.includes(body.status)) {
        await db.query(`UPDATE app.debts SET status = 'in_legal' WHERE id = $1 AND status = 'legal_ready'`, [p.id]);
      }
      return { code: 200 as const, detail: await loadDetail(db, p.id) };
    }).catch((err: { code?: string }) => {
      if (err.code === '23505') return { code: 409 as const, error: 'number_in_use', message: 'This request number is already saved on another case' };
      throw err;
    });
    if (result.code === 404) return reply.code(404).send(notFound);
    if (result.code === 400) {
      return reply.code(400).send({ error: result.error, message: result.message, errors: [{ field: result.field, message: result.message }] });
    }
    if (result.code === 409) return reply.code(409).send({ error: result.error, message: result.message });
    return result.detail;
  });

  // Filing from Talos (5.4) is built next. Until then staff file on Najiz and add the request number by hand.
  app.post('/api/najiz/runs', { preHandler: requireRole(REVIEWER_ROLES) }, async (_req, reply) =>
    reply.code(501).send({ error: 'najiz_not_ready', message: 'Filing on Najiz from Talos comes next. For now, file on Najiz and add the request number to the case by hand.' }),
  );
}
