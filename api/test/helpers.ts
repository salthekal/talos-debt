/** Shared pieces for the Phase 3 tests. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { LocalDiskStorage } from '../src/storage/storage.js';

export const API_URL = process.env.TEST_DATABASE_URL ?? 'postgres://talos_api:talos_api_dev@localhost:5432/talos_test';
export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/talos_test';

// Seed ids (dev/seed.sql)
export const CLIENT = '11111111-1111-4111-8111-111111111111';
export const OWNER = '22222222-2222-4222-8222-000000000001';
export const STAFF = '22222222-2222-4222-8222-000000000002';
export const RAHIM_DEBTOR = '33333333-3333-4333-8333-000000000003';
export const RAHIM_DEBT = '66666666-6666-4666-8666-000000000003';
export const FAHAD_DEBTOR = '33333333-3333-4333-8333-000000000002';
export const SURESH_DEBT = '66666666-6666-4666-8666-000000000005';

// Created by the tests
export const OTHER_CLIENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const OTHER_USER = 'cccccccc-cccc-4ccc-8ccc-000000000001';
export const VIEWER = '22222222-2222-4222-8222-0000000000ee';

export const as = (clientId: string, userId: string) => ({ 'x-client-id': clientId, 'x-user-id': userId });
export const staff = as(CLIENT, STAFF);
export const other = as(OTHER_CLIENT, OTHER_USER);
export const viewer = as(CLIENT, VIEWER);

/** Valid fake IDs (they pass the check digit test). */
export function fakeId(prefix: '1' | '2', seed: number): string {
  const body = `${prefix}${String(seed).padStart(8, '0')}`;
  for (let d = 0; d <= 9; d++) {
    const id = body + d;
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      const x = Number(id[i]);
      sum += i % 2 === 0 ? Math.floor((x * 2) / 10) + ((x * 2) % 10) : x;
    }
    if (sum % 10 === 0) return id;
  }
  throw new Error('unreachable');
}

export interface TestApp {
  app: FastifyInstance;
  pool: pg.Pool;
  admin: pg.Pool;
  storage: LocalDiskStorage;
  storageDir: string;
  close(): Promise<void>;
}

export async function startApp(env: Record<string, string> = {}): Promise<TestApp> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query(
    `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
     VALUES ($1, 'Other Phase 3 Client', '0000000088', 'Other', '+966500000288', 'p3@test.example', 'active')
     ON CONFLICT DO NOTHING`,
    [OTHER_CLIENT],
  );
  await admin.query(
    `INSERT INTO app.users (id, client_id, full_name, email, role)
     VALUES ($1, $2, 'Other Owner', 'p3@test.example', 'owner'),
            ($3, $4, 'Viewer', 'viewer3@demo.example', 'viewer')
     ON CONFLICT DO NOTHING`,
    [OTHER_USER, OTHER_CLIENT, VIEWER, CLIENT],
  );
  const storageDir = mkdtempSync(path.join(tmpdir(), 'talos-files-'));
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, AUTH_MODE: 'dev', STORAGE_LOCAL_DIR: storageDir, ...env });
  const pool = createPool(config.DATABASE_URL);
  const storage = new LocalDiskStorage(storageDir);
  const app = buildApp(config, pool, { storage });
  await app.ready();
  return {
    app, pool, admin, storage, storageDir,
    async close() {
      await app.close();
      await pool.end();
      await admin.end();
    },
  };
}

/** A multipart/form-data body with text fields first, then one file. */
export function multipart(fields: Record<string, string>, file?: { name: string; bytes: Buffer; type?: string }) {
  const boundary = `----talos${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
          `Content-Type: ${file.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** The smallest real PDF and PNG files, for upload tests. */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
