/**
 * Step 3.1: Excel import.
 *
 *   GET  /api/imports/template      the template to fill in
 *   POST /api/imports               upload a filled file (multipart, field "file").
 *                                   Nothing is saved yet except the file and the
 *                                   check report: status 'ready' (no errors) or 'failed'.
 *   GET  /api/imports               recent imports
 *   GET  /api/imports/:id           one import with its report
 *   POST /api/imports/:id/confirm   save every row in one transaction (all or nothing).
 *                                   The rows are checked again first, because the
 *                                   stored data may have changed since the upload.
 *   POST /api/imports/:id/cancel    drop a ready import
 */
import type { FastifyInstance } from 'fastify';
import { EDITOR_ROLES, requireRole, tenantOf } from '../auth.js';
import { withTenant, type Db } from '../db.js';
import { COLUMNS, MAX_IMPORT_BYTES } from '../import/columns.js';
import { parseWorkbook, type ParsedSheet } from '../import/parse.js';
import { buildTemplate } from '../import/template.js';
import { capReport, checkImport, type ImportCheck, type ReportIssue } from '../import/validate.js';
import { loadInstrumentTypes } from '../intake/records.js';
import { duplicateMessage, insertDebtors, insertDebts, insertInstruments, insertPhones, newId } from '../intake/write.js';
import { cleanFileName, detectFileType, insertDocumentRow, storeFile, XLSX_MIME } from '../storage/documents.js';
import { idParam, parseOr400 } from '../validation.js';
import { attachmentHeader, readUpload, type FileDeps } from './upload.js';

const REPORT_FIELDS = `i.id, i.status, i.document_id, doc.file_name, i.rows_total, i.rows_ok, i.rows_failed, i.summary,
                       i.created_by, i.created_at, i.confirmed_by, i.confirmed_at`;

const fileIssue = (message: string): ReportIssue => ({ row: null, column: null, cell: null, message });

async function saveCheck(db: Db, id: string, check: ImportCheck, sheet: ParsedSheet | null, extraWarnings: string[]) {
  const status = check.errors.length ? 'failed' : 'ready';
  const warnings = [...extraWarnings.map(fileIssue), ...check.warnings];
  await db.query(
    `UPDATE app.imports
        SET status = $2, rows_total = $3, rows_ok = $4, rows_failed = $5, errors = $6, warnings = $7, summary = $8,
            rows = $9
      WHERE id = $1`,
    [
      id, status, check.summary.rows, check.summary.rows - check.summary.rows_with_errors, check.summary.rows_with_errors,
      JSON.stringify(capReport(check.errors)), JSON.stringify(capReport(warnings)), JSON.stringify(check.summary),
      // Rows are kept only while the import can still be confirmed.
      status === 'ready' && sheet ? JSON.stringify(sheet) : null,
    ],
  );
  return status;
}

async function loadReport(db: Db, id: string) {
  const { rows } = await db.query(
    `SELECT ${REPORT_FIELDS}, i.errors, i.warnings
       FROM app.imports i JOIN app.documents doc ON doc.id = i.document_id
      WHERE i.id = $1`,
    [id],
  );
  return rows[0];
}

export function importRoutes(app: FastifyInstance, deps: FileDeps) {
  const { pool, storage } = deps;
  const editors = { preHandler: requireRole(EDITOR_ROLES) };

  app.get('/api/imports/template', async (req, reply) => {
    const types = await withTenant(pool, tenantOf(req.user!), (db) => loadInstrumentTypes(db));
    const file = await buildTemplate(types);
    return reply
      .header('content-type', XLSX_MIME)
      .header('content-disposition', attachmentHeader('talos-debts-template.xlsx'))
      .header('cache-control', 'no-store')
      .send(file);
  });

  app.post('/api/imports', editors, async (req, reply) => {
    const upload = await readUpload(req, reply, MAX_IMPORT_BYTES);
    if (!upload) return;
    if (detectFileType(upload.bytes) !== XLSX_MIME) {
      return reply.code(415).send({
        error: 'unsupported_type',
        message: 'Upload an Excel file (.xlsx). Old .xls files and CSV are not supported: open the file in Excel and save it as .xlsx',
      });
    }
    const parsed = await parseWorkbook(upload.bytes);
    if (!parsed.ok && parsed.unreadable) {
      return reply.code(415).send({ error: 'unsupported_type', message: parsed.errors[0] });
    }

    const user = req.user!;
    const doc = {
      clientId: user.clientId,
      docType: 'import_file' as const,
      fileName: cleanFileName(upload.fileName, 'import.xlsx'),
      mimeType: XLSX_MIME,
      bytes: upload.bytes,
      uploadedBy: user.userId,
    };
    // The uploaded file is kept as a document: it shows what the client sent.
    const stored = await storeFile(storage, doc);
    try {
      const report = await withTenant(pool, tenantOf(user), async (db) => {
        await insertDocumentRow(db, doc, stored);
        const id = newId();
        await db.query(
          `INSERT INTO app.imports (id, client_id, document_id, status, created_by)
           VALUES ($1, app.current_client_id(), $2, 'validating', $3)`,
          [id, stored.id, user.userId],
        );
        if (!parsed.ok) {
          const check: ImportCheck = {
            errors: parsed.errors.map(fileIssue),
            warnings: [],
            summary: {
              rows: 0, rows_with_errors: 0, debtors_new: 0, debtors_existing: 0, debts: 0, total_amount: '0.00',
              enforceable_amount: '0.00', instruments_new: 0, instruments_reused: 0, phones_new: 0,
            },
          };
          await saveCheck(db, id, check, null, []);
        } else {
          const check = await checkImport(db, parsed.sheet, id);
          await saveCheck(db, id, check, parsed.sheet, parsed.warnings);
        }
        return loadReport(db, id);
      });
      return reply.code(201).send({ import: report });
    } catch (err) {
      await storage.remove(stored.storageKey).catch(() => undefined);
      throw err;
    }
  });

  app.get('/api/imports', async (req) => {
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `SELECT ${REPORT_FIELDS}
           FROM app.imports i JOIN app.documents doc ON doc.id = i.document_id
          ORDER BY i.created_at DESC LIMIT 50`,
      );
      return { items: rows };
    });
  });

  app.get('/api/imports/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const report = await withTenant(pool, tenantOf(req.user!), (db) => loadReport(db, p.id));
    if (!report) return reply.code(404).send({ error: 'not_found', message: 'Import not found' });
    return { import: report, columns: COLUMNS.map((c) => ({ key: c.key, en: c.en, ar: c.ar, required: !!c.required })) };
  });

  app.post('/api/imports/:id/confirm', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const user = req.user!;
    try {
      const result = await withTenant(pool, tenantOf(user), async (db) => {
        // Lock the import so it cannot be confirmed twice at the same time.
        const found = await db.query<{ status: string; rows: ParsedSheet | null }>(
          `SELECT status, rows FROM app.imports WHERE id = $1 FOR UPDATE`,
          [p.id],
        );
        const imp = found.rows[0];
        if (!imp) return { code: 404, body: { error: 'not_found', message: 'Import not found' } };
        if (imp.status !== 'ready' || !imp.rows) {
          return { code: 409, body: { error: 'not_ready', message: `This import is ${imp.status} and cannot be confirmed` } };
        }

        const check = await checkImport(db, imp.rows, p.id);
        if (!check.plan) {
          // Something changed since the upload (for example a debt reference is now used).
          await saveCheck(db, p.id, check, null, []);
          return {
            code: 409,
            body: { error: 'check_failed', message: 'The rows no longer pass the checks. Nothing was saved.', import: await loadReport(db, p.id) },
          };
        }

        const plan = check.plan;
        await insertDebtors(db, plan.debtors);
        await insertPhones(db, plan.phones);
        await insertInstruments(db, plan.instruments);
        await insertDebts(db, plan.debts, user.userId);
        await db.query(
          `UPDATE app.imports
              SET status = 'imported', rows = NULL, summary = $2, confirmed_by = $3, confirmed_at = now()
            WHERE id = $1`,
          [p.id, JSON.stringify(check.summary), user.userId],
        );
        return { code: 200, body: { import: await loadReport(db, p.id) } };
      });
      return reply.code(result.code).send(result.body);
    } catch (err) {
      // A record was added by someone else at the same moment: the whole import was rolled back.
      const dup = duplicateMessage(err);
      if (dup) {
        return reply.code(409).send({
          error: 'duplicate',
          message: `${dup.message}. Nothing was saved; please upload the file again to get a new check report.`,
        });
      }
      throw err;
    }
  });

  app.post('/api/imports/:id/cancel', editors, async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const result = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query(
        `UPDATE app.imports SET status = 'cancelled', rows = NULL WHERE id = $1 AND status IN ('ready', 'failed') RETURNING id`,
        [p.id],
      );
      return rows[0];
    });
    if (!result) return reply.code(409).send({ error: 'not_allowed', message: 'Only ready or failed imports can be cancelled' });
    return { import: { id: p.id, status: 'cancelled' } };
  });
}
