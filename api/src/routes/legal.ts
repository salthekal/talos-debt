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
 *   POST  /api/legal/:id/pack         make the filing pack PDF (5.1), saved as a legal_pack document
 *   POST  /api/najiz/runs             filing from Talos (5.4): not built yet, answers 501
 *
 * The database refuses a case past `ready` without approval, one open case per
 * debt and per note, and a request number before submitting (0001, 0008).
 * Every change to a case is written to the audit log by its trigger.
 */
import type { FastifyInstance } from 'fastify';
import type { PdfRenderer } from '../legal/pdf.js';
import { buildPack, loadPackData } from '../legal/pack.js';
import { insertDocumentRow, storeFile } from '../storage/documents.js';
import type { FileStorage } from '../storage/storage.js';
import type pg from 'pg';
import { z } from 'zod';
import { EDITOR_ROLES, REVIEWER_ROLES, requireRole, tenantOf, type Role } from '../auth.js';
import { withTenant } from '../db.js';
import { idNumber, phone } from '../intake/normalize.js';
import { loadDetail, loadRows, missingOf, toRow } from '../legal/case.js';
import { idParam, parseOr400 } from '../validation.js';

/** Statuses staff may enter by hand after approval (5.3). */
const MANUAL_STATUSES = ['submitted', 'order_issued', 'measures_applied', 'settled', 'closed', 'withdrawn'] as const;
/** Statuses that mean the request is on Najiz, so the debt is "in legal". */
const ON_NAJIZ = ['submitted', 'order_issued', 'measures_applied'];
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

const notFound = { error: 'not_found', message: 'No legal case for this debt' };

// ------------------------------------------------------------------ routes

export interface LegalDeps {
  pool: pg.Pool;
  storage: FileStorage;
  pdf: PdfRenderer;
}

export function legalRoutes(app: FastifyInstance, { pool, storage, pdf }: LegalDeps) {
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

  app.post('/api/legal/:id/pack', { preHandler: requireRole(REVIEWER_ROLES) }, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const user = req.user!;
    const ctx = tenantOf(user);
    // 1. Read everything inside the client's transaction.
    const data = await withTenant(pool, ctx, (db) => loadPackData(db, p.id));
    if (!data) return reply.code(404).send(notFound);
    // 2. Print and join outside any transaction (it takes a moment).
    const built = await buildPack(data, storage, (html) => pdf.htmlToPdf(html));
    const doc = {
      clientId: user.clientId, docType: 'legal_pack' as const, mimeType: 'application/pdf', bytes: built.bytes,
      fileName: `filing-pack-${data.detail.row.ref_code}.pdf`, debtorId: data.detail.row.debtor_id, debtId: p.id,
      uploadedBy: user.userId, source: 'system_generated' as const,
    };
    const stored = await storeFile(storage, doc);
    try {
      const saved = await withTenant(pool, ctx, async (db) => {
        const row = await insertDocumentRow(db, doc, stored);
        if (data.detail.row.case_id) {
          await db.query(`UPDATE app.legal_cases SET pack_document_id = $2 WHERE id = $1`, [data.detail.row.case_id, row.id]);
        }
        return row;
      });
      return reply.code(201).send({ document: saved, not_attached: [...built.included].filter(([, ok]) => !ok).map(([id]) => id) });
    } catch (err) {
      await storage.remove(stored.storageKey).catch(() => undefined);
      throw err;
    }
  });

  // Filing from Talos (5.4) is built next. Until then staff file on Najiz and add the request number by hand.
  app.post('/api/najiz/runs', { preHandler: requireRole(REVIEWER_ROLES) }, async (_req, reply) =>
    reply.code(501).send({ error: 'najiz_not_ready', message: 'Filing on Najiz from Talos comes next. For now, file on Najiz and add the request number to the case by hand.' }),
  );
}
