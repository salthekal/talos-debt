/**
 * Step 3.4: upload documents per debtor, per debt or per instrument
 * (promissory notes, contracts, IDs, receipts), list them, and download them.
 *
 * Upload: multipart/form-data with the fields first, then the file:
 *   doc_type        one of DOC_TYPES (not import_file or legal_pack)
 *   debtor_id       optional
 *   debt_id         optional (the debtor is taken from the debt)
 *   instrument_id   optional (must belong to the same debtor)
 *   file            PDF, JPEG, PNG, WEBP or HEIC, up to MAX_UPLOAD_MB
 *
 * Documents are evidence for the legal file, so they cannot be deleted here.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EDITOR_ROLES, requireRole, tenantOf } from '../auth.js';
import { withTenant } from '../db.js';
import {
  cleanFileName,
  detectFileType,
  DOC_TYPES,
  DOCUMENT_MIME_TYPES,
  insertDocumentRow,
  storeFile,
  type NewDocument,
} from '../storage/documents.js';
import { idParam, isUuid, parseOr400 } from '../validation.js';
import { attachmentHeader, readUpload, type FileDeps } from './upload.js';

const UPLOADABLE = DOC_TYPES.filter((t) => t !== 'import_file' && t !== 'legal_pack');

const uploadFields = z.object({
  doc_type: z.enum(UPLOADABLE as [string, ...string[]]),
  debtor_id: z.string().refine(isUuid, 'must be a UUID').optional(),
  debt_id: z.string().refine(isUuid, 'must be a UUID').optional(),
  instrument_id: z.string().refine(isUuid, 'must be a UUID').optional(),
});

const listQuery = z.object({
  debtor_id: z.string().refine(isUuid, 'must be a UUID').optional(),
  debt_id: z.string().refine(isUuid, 'must be a UUID').optional(),
  instrument_id: z.string().refine(isUuid, 'must be a UUID').optional(),
  scope: z.enum(['client']).optional(), // client-level papers: CR, IBAN letter, authorization
});

/** Which client-level papers are allowed without a debtor. */
const CLIENT_DOC_TYPES = new Set(['cr', 'establishment_contract', 'iban_letter', 'authorization', 'other']);

export function documentRoutes(app: FastifyInstance, deps: FileDeps) {
  const { pool, storage } = deps;
  const editors = { preHandler: requireRole(EDITOR_ROLES) };

  app.post('/api/documents', editors, async (req, reply) => {
    const upload = await readUpload(req, reply);
    if (!upload) return;
    const f = parseOr400(uploadFields, upload.fields, reply);
    if (!f) return;
    const mime = detectFileType(upload.bytes);
    if (!mime || !(DOCUMENT_MIME_TYPES as readonly string[]).includes(mime)) {
      return reply.code(415).send({ error: 'unsupported_type', message: 'Upload a PDF or a photo (JPEG, PNG, WEBP or HEIC)' });
    }
    const user = req.user!;

    // Work out and check the links before storing anything.
    const links = await withTenant(pool, tenantOf(user), async (db) => {
      let debtorId = f.debtor_id ?? null;
      if (f.debt_id) {
        const d = await db.query<{ debtor_id: string }>(`SELECT debtor_id FROM app.debts WHERE id = $1`, [f.debt_id]);
        if (!d.rows[0]) return { error: 'Debt not found' };
        if (debtorId && debtorId !== d.rows[0].debtor_id) return { error: 'This debt belongs to another debtor' };
        debtorId = d.rows[0].debtor_id;
      }
      if (f.instrument_id) {
        const i = await db.query<{ debtor_id: string }>(`SELECT debtor_id FROM app.instruments WHERE id = $1`, [f.instrument_id]);
        if (!i.rows[0]) return { error: 'Instrument not found' };
        if (debtorId && debtorId !== i.rows[0].debtor_id) return { error: 'This instrument belongs to another debtor' };
        debtorId = i.rows[0].debtor_id;
      }
      if (debtorId && !f.debt_id && !f.instrument_id) {
        const d = await db.query(`SELECT 1 FROM app.debtors WHERE id = $1`, [debtorId]);
        if (!d.rowCount) return { error: 'Debtor not found' };
      }
      if (!debtorId && !CLIENT_DOC_TYPES.has(f.doc_type)) {
        return { error: 'Choose the debtor, debt or instrument this document belongs to' };
      }
      return { debtorId };
    });
    if ('error' in links) {
      const status = links.error!.endsWith('not found') ? 404 : 400;
      return reply.code(status).send({ error: status === 404 ? 'not_found' : 'bad_request', message: links.error });
    }

    const doc: NewDocument = {
      clientId: user.clientId,
      docType: f.doc_type as NewDocument['docType'],
      fileName: cleanFileName(upload.fileName, 'document'),
      mimeType: mime,
      bytes: upload.bytes,
      debtorId: links.debtorId,
      debtId: f.debt_id ?? null,
      instrumentId: f.instrument_id ?? null,
      uploadedBy: user.userId,
    };
    // The file is stored outside the transaction; if saving its row fails, it is removed again.
    const stored = await storeFile(storage, doc);
    try {
      const row = await withTenant(pool, tenantOf(user), (db) => insertDocumentRow(db, doc, stored));
      return reply.code(201).send({ document: row });
    } catch (err) {
      await storage.remove(stored.storageKey).catch(() => undefined);
      throw err;
    }
  });

  app.get('/api/documents', async (req, reply) => {
    const q = parseOr400(listQuery, req.query, reply);
    if (!q) return;
    if (!q.debtor_id && !q.debt_id && !q.instrument_id && !q.scope) {
      return reply.code(400).send({ error: 'bad_request', message: 'Give debtor_id, debt_id, instrument_id or scope=client' });
    }
    return withTenant(pool, tenantOf(req.user!), async (db) => {
      const where: string[] = [];
      const params: unknown[] = [];
      for (const key of ['debtor_id', 'debt_id', 'instrument_id'] as const) {
        if (q[key]) {
          params.push(q[key]);
          where.push(`${key} = $${params.length}`);
        }
      }
      if (q.scope === 'client') where.push('debtor_id IS NULL');
      where.push(`doc_type <> 'import_file'`);
      const { rows } = await db.query(
        `SELECT id, debtor_id, debt_id, instrument_id, doc_type, file_name, mime_type, size_bytes, sha256, source,
                uploaded_by, created_at
           FROM app.documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC`,
        params,
      );
      return { items: rows };
    });
  });

  app.get('/api/documents/:id/download', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const doc = await withTenant(pool, tenantOf(req.user!), async (db) => {
      const { rows } = await db.query<{ storage_key: string; file_name: string; mime_type: string; sha256: string }>(
        `SELECT storage_key, file_name, mime_type, sha256 FROM app.documents WHERE id = $1`,
        [p.id],
      );
      return rows[0];
    });
    if (!doc) return reply.code(404).send({ error: 'not_found', message: 'Document not found' });
    const bytes = await storage.get(doc.storage_key);
    return reply
      .header('content-type', doc.mime_type)
      .header('content-disposition', attachmentHeader(doc.file_name))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .header('x-file-sha256', doc.sha256)
      .send(bytes);
  });
}
