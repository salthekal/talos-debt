/**
 * Where uploaded files live (step 3.3). Only metadata goes in the database
 * (app.documents); the bytes go to one of these:
 *
 *   LocalDiskStorage  development and tests: a folder on this machine.
 *   GcsStorage        production: a private Google Cloud Storage bucket in
 *                     the Dammam region (me-central2). See docs/file-storage.md.
 *
 * Keys look like clients/<client id>/documents/<document id>. They never
 * contain file names, debtor names or ID numbers. Files are never
 * overwritten and never public: they are only read back through the API,
 * after the client check.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';

export interface FileStorage {
  /** Save a new file. Fails if the key is already used. */
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Remove a file. Used only to clean up when saving its database row failed. */
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/-]{0,200}$/;

export function documentKey(clientId: string, documentId: string): string {
  return `clients/${clientId}/documents/${documentId}`;
}

function checkKey(key: string): void {
  if (!KEY_RE.test(key) || key.includes('//') || key.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
}

export class LocalDiskStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private pathFor(key: string): string {
    checkKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  async put(key: string, bytes: Buffer, _contentType?: string): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    // 'wx' refuses to overwrite an existing file.
    await writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/** The small part of a Google Cloud Storage bucket this code uses (tests pass a fake). */
export interface BucketLike {
  file(name: string): {
    save(data: Buffer, options: Record<string, unknown>): Promise<unknown>;
    download(): Promise<[Buffer]>;
    delete(options?: Record<string, unknown>): Promise<unknown>;
  };
}

export class GcsStorage implements FileStorage {
  constructor(
    private readonly bucket: BucketLike,
    /** Optional customer-managed key (Cloud KMS) in the same region. */
    private readonly kmsKeyName?: string,
  ) {}

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    checkKey(key);
    await this.bucket.file(key).save(bytes, {
      resumable: false,
      contentType,
      metadata: { cacheControl: 'private, no-store' },
      // Only create, never replace an existing object.
      preconditionOpts: { ifGenerationMatch: 0 },
      ...(this.kmsKeyName ? { kmsKeyName: this.kmsKeyName } : {}),
    });
  }

  async get(key: string): Promise<Buffer> {
    checkKey(key);
    const [bytes] = await this.bucket.file(key).download();
    return bytes;
  }

  async remove(key: string): Promise<void> {
    checkKey(key);
    await this.bucket.file(key).delete({ ignoreNotFound: true });
  }
}

export async function createStorage(config: Config): Promise<FileStorage> {
  if (config.STORAGE_DRIVER === 'gcs') {
    // Loaded only when used, so development does not need Google credentials.
    const { Storage } = await import('@google-cloud/storage');
    // Credentials come from the environment (the Cloud Run service account).
    const bucket = new Storage().bucket(config.GCS_BUCKET!);
    return new GcsStorage(bucket as unknown as BucketLike, config.GCS_KMS_KEY);
  }
  return new LocalDiskStorage(config.STORAGE_LOCAL_DIR);
}
