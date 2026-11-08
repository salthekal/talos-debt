/** Reading the one file of a multipart upload, with its text fields. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { FileStorage } from '../storage/storage.js';

/** What the file routes need. */
export interface FileDeps {
  pool: pg.Pool;
  storage: FileStorage;
  config: Config;
}

export interface Upload {
  fileName: string;
  bytes: Buffer;
  fields: Record<string, string>;
}

/** Limits for every upload, besides the file size. */
export const UPLOAD_LIMITS = { files: 1, fields: 10, fieldSize: 1000, parts: 12 } as const;

/**
 * Returns undefined after sending the error answer (400, 413) when there is
 * no file or it is too large. maxBytes replaces the configured MAX_UPLOAD_MB
 * (Excel imports have their own limit).
 */
export async function readUpload(req: FastifyRequest, reply: FastifyReply, maxBytes?: number): Promise<Upload | undefined> {
  if (!req.isMultipart()) {
    void reply.code(400).send({ error: 'bad_request', message: 'Send the file as multipart/form-data, in a field named "file"' });
    return undefined;
  }
  // Options passed here replace the plugin's limits as a whole, so always pass all of them.
  const part = maxBytes ? await req.file({ limits: { ...UPLOAD_LIMITS, fileSize: maxBytes } }) : await req.file();
  if (!part) {
    void reply.code(400).send({ error: 'bad_request', message: 'No file was sent' });
    return undefined;
  }
  let bytes: Buffer;
  try {
    bytes = await part.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      void reply.code(413).send({ error: 'too_large', message: 'The file is too large' });
      return undefined;
    }
    throw err;
  }
  if (!bytes.length) {
    void reply.code(400).send({ error: 'bad_request', message: 'The file is empty' });
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const [name, value] of Object.entries(part.fields)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v && 'value' in v && typeof v.value === 'string') fields[name] = v.value;
  }
  return { fileName: part.filename, bytes, fields };
}

/** Content-Disposition that works for Arabic file names too. */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
