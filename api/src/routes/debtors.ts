/**
 * Step 3.2: add and edit debtors, their phones, instruments and debts by hand.
 *
 * Values are checked with the same rules as the Excel import
 * (intake/records.ts). Errors give 400 with a list of { field, message };
 * warnings never block and come back with the saved record.
 * Records of another client are invisible (RLS), so they give 404.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { EDITOR_ROLES, requireRole, tenantOf } from '../auth.js';
import { withTenant, type Db } from '../db.js';
import { instrumentConflict, instrumentKey, pickInstrument } from '../intake/instruments.js';
import { compareAmounts, date } from '../intake/normalize.js';
import {
  checkDebt,
  checkDebtor,
  checkInstrument,
  checkPhones,
  loadInstrumentTypes,
  type DebtFields,
  type DebtorFields,
  type InstrumentFields,
  type InstrumentType,
  type Issue,
} from '../intake/records.js';
import {
  duplicateMessage,
  insertDebtors,
  insertDebts,
  insertInstruments,
  insertPhones,
  newId,
  type NewDebt,
  type NewInstrument,
} from '../intake/write.js';
import { idParam, parseOr400 } from '../validation.js';

const MAX_PHONES = 10;
const MAX_DEBTS_PER_REQUEST = 50;

/** A problem that should reach the user as a 4xx answer, thrown inside a transaction to roll it back. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.message ?? 'refused'));
  }
}

const invalid = (errors: Issue[], warnings: Issue[] = []) =>
  new Refusal(400, { error: 'invalid', message: errors.map((e) => `${e.field}: ${e.message}`).join('; '), errors, warnings });

const notFound = (what: string) => new Refusal(404, { error: 'not_found', message: `${what} not found` });

const prefixed = (prefix: string, issues: Issue[]) => issues.map((i) => ({ field: `${prefix}.${i.field}`, message: i.message }));

async function respond(reply: FastifyReply, code: number, work: () => Promise<unknown>) {
  try {
    const result = await work();
    return reply.code(code).send(result);
  } catch (err) {
    if (err instanceof Refusal) return reply.code(err.status).send(err.body);
    const dup = duplicateMessage(err);
    if (dup) return reply.code(409).send({ error: 'duplicate', message: dup.message, errors: [dup] });
    throw err;
  }
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const phoneEntry = z.union([
  z.string(),
  z.number(),
  z.object({ phone: z.union([z.string(), z.number()]), label: z.string().trim().max(50).optional() }),
]);

const createBody = z
  .object({
    phones: z.array(phoneEntry).min(1, 'add at least one phone number').max(MAX_PHONES),
    debts: z.array(z.record(z.string(), z.unknown())).max(MAX_DEBTS_PER_REQUEST).optional(),
  })
  .passthrough();

const debtorStatus = z.enum(['active', 'paused', 'do_not_contact', 'closed']);

const listQuery = z.object({
  search: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const phoneBody = z.object({
  phone: z.union([z.string(), z.number()]),
  label: z.string().trim().max(50).optional(),
  is_primary: z.boolean().optional(),
});

const phoneUpdate = z
  .object({
    label: z.string().trim().max(50).nullable().optional(),
    is_primary: z.literal(true).optional(),
    status: z.enum(['active', 'wrong_number', 'opted_out', 'unreachable']).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

type DebtInput = { fields: DebtFields; instrument: InstrumentFields | null; instrumentId: string | null };

/** Check the debts of one request, including their instruments. */
function checkDebtList(raw: Record<string, unknown>[], types: InstrumentType[]) {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const debts: DebtInput[] = [];
  raw.forEach((d, i) => {
    const debt = checkDebt(d, 'create');
    errors.push(...prefixed(`debts[${i}]`, debt.errors));
    warnings.push(...prefixed(`debts[${i}]`, debt.warnings));
    let instrument: InstrumentFields | null = null;
    let instrumentId: string | null = null;
    if (typeof d.instrument_id === 'string') {
      instrumentId = d.instrument_id;
    } else if (d.instrument !== undefined && d.instrument !== null) {
      const inst = checkInstrument(asRecord(d.instrument), types, 'create');
      errors.push(...prefixed(`debts[${i}].instrument`, inst.errors));
      warnings.push(...prefixed(`debts[${i}].instrument`, inst.warnings));
      instrument = inst.value as InstrumentFields | null;
    }
    debts.push({ fields: debt.value as DebtFields, instrument, instrumentId });
  });
  const refs = new Set<string>();
  debts.forEach((d, i) => {
    const r = d.fields.ref_code?.toUpperCase();
    if (!r) return;
    if (refs.has(r)) errors.push({ field: `debts[${i}].ref_code`, message: `Debt reference ${d.fields.ref_code} is used twice` });
    refs.add(r);
  });
  return { debts, errors, warnings };
}

/**
 * Save debts for one debtor. Instruments with the same type and reference
 * number are stored once and shared, also with instruments already stored.
 */
async function saveDebts(db: Db, debtorId: string, list: DebtInput[], userId: string) {
  const newInstruments: NewInstrument[] = [];
  const byKey = new Map<string, { id: string; fields: InstrumentFields }>();
  const rows: NewDebt[] = [];

  for (const [i, d] of list.entries()) {
    let instrumentId: string | null = null;
    if (d.instrumentId) {
      const own = await db.query(`SELECT 1 FROM app.instruments WHERE id = $1 AND debtor_id = $2`, [d.instrumentId, debtorId]);
      if (!own.rowCount) throw invalid([{ field: `debts[${i}].instrument_id`, message: 'This instrument does not belong to this debtor' }]);
      instrumentId = d.instrumentId;
    } else if (d.instrument) {
      const key = instrumentKey(debtorId, d.instrument);
      const seen = key ? byKey.get(key) : undefined;
      if (seen) {
        const conflict = instrumentConflict(seen.fields, d.instrument);
        if (conflict) {
          throw invalid([{ field: `debts[${i}].instrument`, message: `Same instrument as an earlier debt but different details (${conflict})` }]);
        }
        instrumentId = seen.id;
      } else {
        const pick = await pickInstrument(db, debtorId, d.instrument);
        if (pick.kind === 'existing') {
          instrumentId = pick.id;
        } else {
          newInstruments.push(pick.record);
          instrumentId = pick.record.id;
        }
        if (key) byKey.set(key, { id: instrumentId, fields: d.instrument });
      }
    }
    rows.push({ ...d.fields, id: newId(), debtor_id: debtorId, instrument_id: instrumentId });
  }

  await insertInstruments(db, newInstruments);
  const refs = await insertDebts(db, rows, userId);
  return rows.map((r) => ({ id: r.id, ref_code: refs.get(r.id)!, instrument_id: r.instrument_id }));
}

export function debtorRoutes(app: FastifyInstance, pool: pg.Pool) {
  const editors = { preHandler: requireRole(EDITOR_ROLES) };

  // Dropdown values for forms: instrument types and what Najiz calls them.
  app.get('/api/instrument-types', async (req) => {
    return withTenant(pool, tenantOf(req.user!), async (db) => ({ items: await loadInstrumentTypes(db) }));
  });

  // Find debtors (for example before adding one, to avoid a duplicate).
  app.get('/api/debtors', async (req, reply) => {
    const q = parseOr400(listQuery, req.query, reply);
    if (!q) return;
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const params: unknown[] = [];
      let where = '';
      if (q.search) {
        params.push(`%${q.search}%`);
        where = `WHERE d.full_name ILIKE $1 OR d.full_name_ar ILIKE $1 OR d.ref_code ILIKE $1 OR d.id_number ILIKE $1
                    OR EXISTS (SELECT 1 FROM app.debtor_phones p WHERE p.debtor_id = d.id AND p.phone_e164 ILIKE $1)`;
      }
      const total = await db.query<{ count: string }>(`SELECT count(*) FROM app.debtors d ${where}`, params);
      params.push(q.limit, q.offset);
      const { rows } = await db.query(
        `SELECT d.id, d.ref_code, d.full_name, d.full_name_ar, d.id_type, d.id_number, d.status, d.created_at,
                coalesce(sum(x.amount_outstanding) FILTER (WHERE x.status NOT IN ('paid','closed','written_off')), 0)::numeric(12,2)
                  AS open_balance,
                count(x.id) AS debts
           FROM app.debtors d LEFT JOIN app.debts x ON x.debtor_id = d.id
           ${where}
          GROUP BY d.id
          ORDER BY d.created_at DESC, d.ref_code
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { total: Number(total.rows[0]?.count ?? 0), limit: q.limit, offset: q.offset, items: rows };
    });
  });

  // New debtor with phones, and optionally debts (each with its instrument).
  app.post('/api/debtors', editors, async (req, reply) => {
    const body = parseOr400(createBody, req.body ?? {}, reply);
    if (!body) return;
    const user = req.user!;
    return respond(reply, 201, () =>
      withTenant(pool, tenantOf(user), async (db) => {
        const types = await loadInstrumentTypes(db);
        const debtor = checkDebtor(body, 'create');
        const phoneValues = body.phones.map((p) => (typeof p === 'object' ? p.phone : p));
        const phones = checkPhones(phoneValues);
        const debts = checkDebtList(body.debts ?? [], types);
        const errors = [...debtor.errors, ...phones.errors, ...debts.errors];
        const warnings = [...debtor.warnings, ...phones.warnings, ...debts.warnings];
        if (errors.length) throw invalid(errors, warnings);

        const d = debtor.value as DebtorFields;
        const existing = await db.query<{ id: string; ref_code: string }>(
          `SELECT id, ref_code FROM app.debtors WHERE id_type = $1 AND id_number = $2`,
          [d.id_type, d.id_number],
        );
        if (existing.rows[0]) {
          throw new Refusal(409, {
            error: 'debtor_exists',
            message: `This ID number belongs to debtor ${existing.rows[0].ref_code}. Add the debt to that debtor instead.`,
            debtor_id: existing.rows[0].id,
          });
        }

        const id = newId();
        const refs = await insertDebtors(db, [{ ...d, id }]);
        const labels = new Map(body.phones.map((p, i) => [i, typeof p === 'object' ? (p.label ?? null) : null]));
        await insertPhones(
          db,
          phones.value.map((phone_e164, i) => ({ debtor_id: id, phone_e164, is_primary: i === 0, label: labels.get(i) ?? null })),
        );
        const savedDebts = await saveDebts(db, id, debts.debts, user.userId);
        return { debtor: { id, ref_code: refs.get(id) }, debts: savedDebts, warnings };
      }),
    );
  });

  app.patch('/api/debtors/:id', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const input = asRecord(req.body);
    const status = input.status === undefined ? undefined : debtorStatus.safeParse(input.status);
    if (status && !status.success) {
      return reply.code(400).send({ error: 'invalid', message: 'status: not an allowed value', errors: [{ field: 'status', message: 'not an allowed value' }] });
    }
    return respond(reply, 200, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const current = await db.query<{ id_type: string }>(`SELECT id_type FROM app.debtors WHERE id = $1`, [p.id]);
        if (!current.rows[0]) throw notFound('Debtor');
        const fields = { ...input };
        delete fields.status;
        // A new ID number alone keeps the current ID type.
        if ('id_number' in fields && !('id_type' in fields)) fields.id_type = current.rows[0].id_type;
        const checked = checkDebtor(fields, 'update');
        if (checked.errors.length) throw invalid(checked.errors, checked.warnings);
        const changes: Record<string, unknown> = { ...checked.value };
        if (status?.success) changes.status = status.data;
        const keys = Object.keys(changes);
        if (!keys.length) throw invalid([{ field: 'input', message: 'Nothing to change' }]);
        const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
        const { rows } = await db.query(
          `UPDATE app.debtors SET ${sets} WHERE id = $1
           RETURNING id, ref_code, debtor_kind, id_type, id_number, full_name, full_name_ar, nationality,
                     preferred_language, national_address, employment_status, status, notes`,
          [p.id, ...keys.map((k) => changes[k])],
        );
        return { debtor: rows[0], warnings: checked.warnings };
      }),
    );
  });

  app.post('/api/debtors/:id/phones', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(phoneBody, req.body ?? {}, reply);
    if (!body) return;
    return respond(reply, 201, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const exists = await db.query(`SELECT 1 FROM app.debtors WHERE id = $1`, [p.id]);
        if (!exists.rowCount) throw notFound('Debtor');
        const checked = checkPhones([body.phone], 'phone');
        if (checked.errors.length) throw invalid(checked.errors);
        const phone = checked.value[0]!;
        if (body.is_primary) await db.query(`UPDATE app.debtor_phones SET is_primary = false WHERE debtor_id = $1`, [p.id]);
        const { rows } = await db.query(
          `INSERT INTO app.debtor_phones (client_id, debtor_id, phone_e164, label, is_primary)
           SELECT app.current_client_id(), $1, $2, $3,
                  $4 OR NOT EXISTS (SELECT 1 FROM app.debtor_phones WHERE debtor_id = $1 AND is_primary)
           RETURNING id, phone_e164, label, is_primary, status`,
          [p.id, phone, body.label ?? null, body.is_primary ?? false],
        );
        return { phone: rows[0], warnings: checked.warnings };
      }),
    );
  });

  // Mark a number wrong or opted out (stops messages to it), relabel it, or make it the main number.
  app.patch('/api/phones/:id', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const body = parseOr400(phoneUpdate, req.body ?? {}, reply);
    if (!body) return;
    return respond(reply, 200, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const found = await db.query<{ debtor_id: string }>(`SELECT debtor_id FROM app.debtor_phones WHERE id = $1`, [p.id]);
        if (!found.rows[0]) throw notFound('Phone');
        if (body.is_primary) {
          await db.query(`UPDATE app.debtor_phones SET is_primary = false WHERE debtor_id = $1 AND id <> $2`, [
            found.rows[0].debtor_id,
            p.id,
          ]);
        }
        const { rows } = await db.query(
          `UPDATE app.debtor_phones
              SET label = CASE WHEN $2 THEN $3 ELSE label END,
                  is_primary = coalesce($4, is_primary),
                  status = coalesce($5, status)
            WHERE id = $1
            RETURNING id, phone_e164, label, is_primary, status`,
          [p.id, body.label !== undefined, body.label ?? null, body.is_primary ?? null, body.status ?? null],
        );
        return { phone: rows[0] };
      }),
    );
  });

  app.get('/api/debtors/:id/instruments', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const result = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const exists = await db.query(`SELECT 1 FROM app.debtors WHERE id = $1`, [p.id]);
      if (!exists.rowCount) return undefined;
      const { rows } = await db.query(
        `SELECT i.id, i.type_code, t.name_en, t.name_ar, t.directly_enforceable, t.has_time_limit,
                i.reference_number, i.issue_date, i.due_date, i.face_amount, i.enforceable_until,
                i.verified_by, i.verified_at, i.notes,
                (SELECT count(*) FROM app.debts d WHERE d.instrument_id = i.id) AS debts
           FROM app.instruments i JOIN app.instrument_types t ON t.code = i.type_code
          WHERE i.debtor_id = $1 ORDER BY i.created_at`,
        [p.id],
      );
      return { items: rows };
    });
    if (!result) return reply.code(404).send({ error: 'not_found', message: 'Debtor not found' });
    return result;
  });

  app.post('/api/debtors/:id/instruments', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const input = asRecord(req.body);
    return respond(reply, 201, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const exists = await db.query(`SELECT 1 FROM app.debtors WHERE id = $1`, [p.id]);
        if (!exists.rowCount) throw notFound('Debtor');
        const types = await loadInstrumentTypes(db);
        const checked = checkInstrument(input, types, 'create');
        if (checked.errors.length) throw invalid(checked.errors, checked.warnings);
        if (!checked.value) throw invalid([{ field: 'type', message: 'Instrument type is empty' }]);
        const id = newId();
        await insertInstruments(db, [{ ...(checked.value as InstrumentFields), id, debtor_id: p.id }]);
        return { instrument: { id }, warnings: checked.warnings };
      }),
    );
  });

  app.patch('/api/instruments/:id', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const input = asRecord(req.body);
    const user = req.user!;
    return respond(reply, 200, () =>
      withTenant(pool, tenantOf(user), async (db) => {
        const exists = await db.query(`SELECT 1 FROM app.instruments WHERE id = $1`, [p.id]);
        if (!exists.rowCount) throw notFound('Instrument');
        const types = await loadInstrumentTypes(db);
        const fields = { ...input };
        delete fields.verified;
        delete fields.notes;
        delete fields.enforceable_until;
        const checked = checkInstrument(fields, types, 'update');
        // A deadline for this instrument only, for example a paper note with its own end date (3.5).
        const until = 'enforceable_until' in input ? date(input.enforceable_until, 'Enforceable until') : undefined;
        if (until && !until.ok) checked.errors.push({ field: 'enforceable_until', message: until.error });
        if (checked.errors.length) throw invalid(checked.errors, checked.warnings);
        const changes: Record<string, unknown> = { ...(checked.value ?? {}) };
        if (until?.ok) changes.enforceable_until = until.value ?? null;
        if (typeof input.notes === 'string' || input.notes === null) changes.notes = input.notes;
        if (input.verified === true) {
          changes.verified_by = user.userId;
          changes.verified_at = new Date().toISOString();
        }
        const keys = Object.keys(changes);
        if (!keys.length) throw invalid([{ field: 'input', message: 'Nothing to change' }]);
        const { rows } = await db.query(
          `UPDATE app.instruments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1
           RETURNING id, type_code, reference_number, issue_date, due_date, face_amount, enforceable_until,
                     verified_by, verified_at, notes`,
          [p.id, ...keys.map((k) => changes[k])],
        );
        return { instrument: rows[0], warnings: checked.warnings };
      }),
    );
  });

  // Add one or more debts to an existing debtor (the same shape as "debts" when creating a debtor).
  app.post('/api/debtors/:id/debts', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const input = req.body;
    const list = Array.isArray(asRecord(input).debts) ? (asRecord(input).debts as unknown[]) : [input];
    if (!list.length || list.length > MAX_DEBTS_PER_REQUEST) {
      return reply.code(400).send({ error: 'invalid', message: `Send between 1 and ${MAX_DEBTS_PER_REQUEST} debts` });
    }
    const user = req.user!;
    return respond(reply, 201, () =>
      withTenant(pool, tenantOf(user), async (db) => {
        const exists = await db.query(`SELECT 1 FROM app.debtors WHERE id = $1`, [p.id]);
        if (!exists.rowCount) throw notFound('Debtor');
        const types = await loadInstrumentTypes(db);
        const debts = checkDebtList(list.map(asRecord), types);
        if (debts.errors.length) throw invalid(debts.errors, debts.warnings);
        const saved = await saveDebts(db, p.id, debts.debts, user.userId);
        return { debts: saved, warnings: debts.warnings };
      }),
    );
  });

  /**
   * Change a debt's details. The amount can be corrected (for example after a
   * valid dispute) while the debt is still being followed up; the balance is
   * recalculated from the approved payments.
   */
  app.patch('/api/debts/:id', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const input = asRecord(req.body);
    return respond(reply, 200, () =>
      withTenant(pool, tenantOf(req.user!), async (db) => {
        const found = await db.query<{ debtor_id: string; status: string; issue_date: string | null; due_date: string | null }>(
          `SELECT debtor_id, status, to_char(issue_date, 'YYYY-MM-DD') AS issue_date, to_char(due_date, 'YYYY-MM-DD') AS due_date
             FROM app.debts WHERE id = $1`,
          [p.id],
        );
        const debt = found.rows[0];
        if (!debt) throw notFound('Debt');
        const types = await loadInstrumentTypes(db);

        const fields = { ...input };
        delete fields.instrument_id;
        delete fields.instrument;
        const checked = checkDebt(fields, 'update');
        const errors = [...checked.errors];
        const warnings = [...checked.warnings];
        const changes: Record<string, unknown> = { ...checked.value };
        delete changes.amount_original;

        // Dates are checked against each other, including the one not being changed.
        const issue = 'issue_date' in checked.value ? checked.value.issue_date : debt.issue_date;
        const due = 'due_date' in checked.value ? checked.value.due_date : debt.due_date;
        if (issue && due && due < issue && !errors.some((e) => e.field === 'due_date')) {
          errors.push({ field: 'due_date', message: `Due date ${due} is before the issue date ${issue}` });
        }

        if ('instrument_id' in input) {
          if (input.instrument_id === null) {
            changes.instrument_id = null;
          } else if (typeof input.instrument_id === 'string') {
            const own = await db.query(`SELECT 1 FROM app.instruments WHERE id = $1 AND debtor_id = $2`, [
              input.instrument_id,
              debt.debtor_id,
            ]);
            if (!own.rowCount) errors.push({ field: 'instrument_id', message: 'This instrument does not belong to this debtor' });
            else changes.instrument_id = input.instrument_id;
          }
        } else if (input.instrument !== undefined) {
          const inst = checkInstrument(asRecord(input.instrument), types, 'create');
          errors.push(...prefixed('instrument', inst.errors));
          warnings.push(...prefixed('instrument', inst.warnings));
          if (!inst.errors.length) {
            if (inst.value === null) {
              changes.instrument_id = null;
            } else {
              const pick = await pickInstrument(db, debt.debtor_id, inst.value as InstrumentFields);
              if (pick.kind === 'new') await insertInstruments(db, [pick.record]);
              changes.instrument_id = pick.kind === 'new' ? pick.record.id : pick.id;
            }
          }
        }
        if (errors.length) throw invalid(errors, warnings);

        const newAmount = checked.value.amount_original;
        if (newAmount) {
          if (['paid', 'closed', 'written_off', 'legal_ready', 'in_legal'].includes(debt.status)) {
            throw new Refusal(409, {
              error: 'not_allowed',
              message: `The amount cannot be changed while the debt is ${debt.status.replace('_', ' ')}`,
            });
          }
          const paid = await db.query<{ paid: string }>(
            `SELECT coalesce(sum(amount), 0)::numeric(12,2)::text AS paid FROM app.payments WHERE debt_id = $1 AND status = 'approved'`,
            [p.id],
          );
          const paidSoFar = paid.rows[0]!.paid;
          if (compareAmounts(newAmount, paidSoFar) <= 0) {
            throw invalid([{ field: 'amount', message: `The debtor has already paid ${paidSoFar}. The amount must be more than that` }]);
          }
          changes.amount_original = newAmount;
        }

        const keys = Object.keys(changes);
        if (!keys.length) throw invalid([{ field: 'input', message: 'Nothing to change' }]);
        // In one UPDATE, amount_original on the right side is still the old value,
        // so the balance is recalculated in a second step.
        const { rows } = await db.query(
          `UPDATE app.debts SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING id`,
          [p.id, ...keys.map((k) => changes[k])],
        );
        if (newAmount) {
          await db.query(
            `UPDATE app.debts SET amount_outstanding = amount_original - (SELECT coalesce(sum(amount), 0) FROM app.payments
                                                                          WHERE debt_id = $1 AND status = 'approved')
              WHERE id = $1`,
            [p.id],
          );
        }
        const out = await db.query(`SELECT * FROM app.v_debt_overview WHERE debt_id = $1`, [rows[0]!.id]);
        return { debt: out.rows[0], warnings };
      }),
    );
  });
}
