/**
 * Saving and reading documents: the file goes to storage, its details to
 * app.documents. Shared by document upload (3.4) and Excel imports (3.1).
 *
 * The file type is decided from the file's own first bytes, never from its
 * name or what the browser claims, so a renamed program cannot pass as a PDF.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Db } from '../db.js';
import { documentKey, type FileStorage } from './storage.js';

export const DOC_TYPES = [
  'cr', 'establishment_contract', 'iban_letter', 'authorization',
  'national_id', 'iqama', 'employment_contract',
  'promissory_note', 'cheque', 'judgment', 'contract', 'invoice',
  'receipt', 'payment_proof', 'legal_pack', 'import_file', 'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** File types people may upload as documents (scans and photos of papers). */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;

const startsWith = (b: Buffer, bytes: number[], offset = 0) =>
  b.length >= offset + bytes.length && bytes.every((x, i) => b[offset + i] === x);
const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

/** What a file really is, from its first bytes. Undefined when not an allowed type. */
export function detectFileType(bytes: Buffer): string | undefined {
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1'].includes(ascii(bytes, 8, 12))) return 'image/heic';
  // Excel files are zip archives; the parser checks the inside.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return XLSX_MIME;
  return undefined;
}

/** A safe display name: no folders, no control characters, at most 200 characters. */
export function cleanFileName(name: string | undefined, fallback = 'file'): string {
  const base = path.basename((name ?? '').replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 200);
  return cleaned || fallback;
}

export interface NewDocument {
  clientId: string;
  docType: DocType;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  debtorId?: string | null;
  debtId?: string | null;
  instrumentId?: string | null;
  uploadedBy?: string | null;
  source?: 'client_upload' | 'whatsapp_inbound' | 'system_generated';
}

export interface StoredFile {
  id: string;
  storageKey: string;
  sha256: string;
}

/**
 * Step 1, outside any transaction: put the bytes in storage.
 * Step 2 (insertDocumentRow) runs inside the transaction. If it fails,
 * call storage.remove(storageKey) so no file is left without a row.
 */
export async function storeFile(storage: FileStorage, doc: NewDocument): Promise<StoredFile> {
  const id = randomUUID();
  const storageKey = documentKey(doc.clientId, id);
  const sha256 = createHash('sha256').update(doc.bytes).digest('hex');
  await storage.put(storageKey, doc.bytes, doc.mimeType);
  return { id, storageKey, sha256 };
}

export async function insertDocumentRow(db: Db, doc: NewDocument, stored: StoredFile) {
  const { rows } = await db.query(
    `INSERT INTO app.documents (id, client_id, debtor_id, debt_id, instrument_id, doc_type, file_name,
                                storage_key, mime_type, size_bytes, sha256, source, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, debtor_id, debt_id, instrument_id, doc_type, file_name, mime_type, size_bytes, sha256,
               source, uploaded_by, created_at`,
    [
      stored.id, doc.clientId, doc.debtorId ?? null, doc.debtId ?? null, doc.instrumentId ?? null,
      doc.docType, doc.fileName, stored.storageKey, doc.mimeType, doc.bytes.length, stored.sha256,
      doc.source ?? 'client_upload', doc.uploadedBy ?? null,
    ],
  );
  return rows[0];
}
