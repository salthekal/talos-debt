/**
 * The shared value rules (intake/normalize.ts) and file storage (step 3.3).
 * No API here: these are the building blocks both manual entry and the
 * Excel import use.
 */
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import * as n from '../src/intake/normalize.js';
import { checkDebt, checkDebtor, checkPhones } from '../src/intake/records.js';
import { paperNoteDeadline } from '../src/routes/enforceability.js';
import { cleanFileName, detectFileType, XLSX_MIME } from '../src/storage/documents.js';
import { documentKey, GcsStorage, LocalDiskStorage, type BucketLike } from '../src/storage/storage.js';
import { API_URL, fakeId, PDF, PNG } from './helpers.js';

const value = <T>(c: n.Check<T>) => {
  if (!c.ok) throw new Error(c.error);
  return c.value;
};

describe('phone numbers', () => {
  it.each([
    ['0501234567', '+966501234567'],
    ['050 123 4567', '+966501234567'],
    ['050-123-4567', '+966501234567'],
    ['501234567', '+966501234567'], // Excel dropped the 0
    [501234567, '+966501234567'],
    ['966501234567', '+966501234567'],
    ['+966501234567', '+966501234567'],
    ['00966501234567', '+966501234567'],
    ['+966 0501234567', '+966501234567'],
    ['٠٥٠١٢٣٤٥٦٧', '+966501234567'], // Arabic digits
    ['+92 300 1234567', '+923001234567'],
    ['00923001234567', '+923001234567'],
  ])('%s becomes %s', (raw, expected) => {
    expect(value(n.phone(raw))).toBe(expected);
  });

  it.each(['12345', 'abc', '3001234567', '+9665012345'])('refuses %s', (raw) => {
    expect(n.phone(raw).ok).toBe(false);
  });

  it('warns about Saudi landlines (no WhatsApp)', () => {
    const r = n.phone('+966126543210');
    expect(r.ok && r.warning).toMatch(/not a Saudi mobile/);
  });

  it('joins repeated numbers into one', () => {
    expect(checkPhones(['0501234567', '+966501234567', null, '']).value).toEqual(['+966501234567']);
  });
});

describe('ID numbers', () => {
  it('checks the length and first digit of Saudi IDs and iqamas', () => {
    expect(value(n.idNumber('iqama', fakeId('2', 1)))).toBe(fakeId('2', 1));
    expect(n.idNumber('iqama', '1000000001').ok).toBe(false);
    expect(n.idNumber('national_id', '123').ok).toBe(false);
  });

  it('only warns when the check digit is wrong', () => {
    const id = fakeId('1', 42);
    const wrong = id.slice(0, 9) + String((Number(id[9]) + 1) % 10);
    const r = n.idNumber('national_id', wrong);
    expect(r.ok).toBe(true);
    expect(r.ok && r.warning).toMatch(/check digit/);
  });

  it('guesses the ID type from the first digit', () => {
    expect(n.guessIdType('1012345678')).toBe('national_id');
    expect(n.guessIdType(2012345678)).toBe('iqama');
    expect(n.guessIdType('AB12345')).toBeUndefined();
  });
});

describe('amounts stay exact text', () => {
  it.each([
    [1500, '1500.00'],
    [1280.5, '1280.50'],
    ['1,500.75', '1500.75'],
    ['SAR 2000', '2000.00'],
    ['2000 ر.س', '2000.00'],
    ['١٥٠٠٫٥', '1500.50'],
    ['0.10', '0.10'],
    ['007', '7.00'],
  ])('%s becomes %s', (raw, expected) => {
    expect(value(n.amount(raw))).toBe(expected);
  });

  it.each([0, -5, '0', '-10', '12.345', 'ten', '', '12345678901'])('refuses %s', (raw) => {
    expect(n.amount(raw).ok).toBe(false);
  });

  it('compares amounts without rounding', () => {
    expect(n.compareAmounts('1500.00', '1499.99')).toBe(1);
    expect(n.compareAmounts('0.10', '0.10')).toBe(0);
  });
});

describe('dates', () => {
  it.each([
    ['2026-09-30', '2026-09-30'],
    ['30/09/2026', '2026-09-30'],
    ['1/2/2026', '2026-02-01'], // day first, as in Saudi Arabia
    [new Date(Date.UTC(2026, 8, 30)), '2026-09-30'],
    [46295, '2026-09-30'], // Excel day number
  ])('%s becomes %s', (raw, expected) => {
    expect(value(n.date(raw))).toBe(expected);
  });

  it('refuses Hijri dates with a clear message', () => {
    const r = n.date('15/03/1447');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Hijri/);
  });

  it('refuses dates that do not exist', () => {
    expect(n.date('31/02/2026').ok).toBe(false);
    expect(n.date('next week').ok).toBe(false);
  });

  it('empty is allowed', () => {
    expect(value(n.date(''))).toBeUndefined();
  });
});

describe('list values in English or Arabic', () => {
  it('accepts the code, the English, the Arabic and the template label', () => {
    const lang = n.matcher(n.LANGUAGE_CHOICES);
    expect(lang('ur')).toBe('ur');
    expect(lang('Urdu')).toBe('ur');
    expect(lang('الأردية')).toBe('ur');
    expect(lang('Urdu / الأردية')).toBe('ur');
    expect(lang('Klingon')).toBeUndefined();
  });

  it('turns nationality names into codes, and only warns for unknown ones', () => {
    expect(value(n.nationality('Pakistani'))).toBe('PK');
    expect(value(n.nationality('بنغلاديش'))).toBe('BD');
    const r = n.nationality('Atlantis');
    expect(r.ok && r.value).toBeUndefined();
    expect(r.ok && r.warning).toMatch(/not recognised/);
  });
});

describe('record checks shared by forms and Excel', () => {
  it('a debtor needs an ID and a name; defaults fill the rest', () => {
    const ok = checkDebtor({ id_number: fakeId('2', 7), full_name: 'Test Person' }, 'create');
    expect(ok.errors).toEqual([]);
    expect(ok.value).toMatchObject({ id_type: 'iqama', debtor_kind: 'person', preferred_language: 'ar', employment_status: 'unknown' });
    const bad = checkDebtor({ id_number: 'X1', full_name: '' }, 'create');
    expect(bad.errors.map((e) => e.field).sort()).toEqual(['full_name', 'id_type']);
  });

  it('a debt due before it was issued is refused', () => {
    const r = checkDebt({ amount: 100, reason: 'Test reason', issue_date: '2026-05-10', due_date: '2026-05-01' }, 'create');
    expect(r.errors[0]?.field).toBe('due_date');
  });
});

describe('file types are read from the file itself', () => {
  it('knows PDF, PNG and Excel files', () => {
    expect(detectFileType(PDF)).toBe('application/pdf');
    expect(detectFileType(PNG)).toBe('image/png');
    expect(detectFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2]))).toBe(XLSX_MIME);
  });

  it('does not trust the file name', () => {
    expect(detectFileType(Buffer.from('MZ\x90\x00 this is a program'))).toBeUndefined();
    expect(detectFileType(Buffer.from('<html><script>'))).toBeUndefined();
  });

  it('cleans file names', () => {
    expect(cleanFileName('../../etc/passwd')).toBe('passwd');
    expect(cleanFileName('C:\\Users\\x\\سند لأمر.pdf')).toBe('سند لأمر.pdf');
    expect(cleanFileName('')).toBe('file');
  });
});

describe('file storage (3.3)', () => {
  it('saves and reads files, and never overwrites one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'talos-store-'));
    const s = new LocalDiskStorage(dir);
    const key = documentKey('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001');
    await s.put(key, PDF, 'application/pdf');
    expect((await s.get(key)).equals(PDF)).toBe(true);
    await expect(s.put(key, PNG, 'image/png')).rejects.toThrow();
    await s.remove(key);
    await expect(s.get(key)).rejects.toThrow();
  });

  it('refuses keys that try to leave the storage folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'talos-store-'));
    const s = new LocalDiskStorage(dir);
    await expect(s.put('../escape', PDF, 'application/pdf')).rejects.toThrow(/Invalid storage key/);
    await expect(s.put('clients/../../escape', PDF, 'application/pdf')).rejects.toThrow(/Invalid storage key/);
    await expect(s.put('/etc/x', PDF, 'application/pdf')).rejects.toThrow(/Invalid storage key/);
    expect(readdirSync(path.dirname(dir)).includes('escape')).toBe(false);
  });

  it('Google Cloud Storage: create-only, private, optional encryption key', async () => {
    const calls: { name: string; options?: Record<string, unknown> }[] = [];
    const bucket: BucketLike = {
      file: (name) => ({
        save: async (_d, options) => void calls.push({ name, options }),
        download: async () => [PDF],
        delete: async (options) => void calls.push({ name, options }),
      }),
    };
    const s = new GcsStorage(bucket, 'projects/p/locations/me-central2/keyRings/r/cryptoKeys/k');
    await s.put('clients/x/documents/y', PDF, 'application/pdf');
    expect(calls[0]!.options).toMatchObject({
      contentType: 'application/pdf',
      preconditionOpts: { ifGenerationMatch: 0 },
      kmsKeyName: expect.stringContaining('me-central2'),
      metadata: { cacheControl: 'private, no-store' },
    });
    expect((await s.get('clients/x/documents/y')).equals(PDF)).toBe(true);
    await expect(s.put('../x', PDF, 'application/pdf')).rejects.toThrow();
  });

  it('Cloud Storage needs a bucket name', () => {
    // (Production also refuses STORAGE_DRIVER=local, but production cannot start at all
    // until real login replaces AUTH_MODE=dev, so that rule is checked in config.ts only.)
    expect(() => loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL, STORAGE_DRIVER: 'gcs' })).toThrow(/GCS_BUCKET/);
  });
});

describe('Enforcement Law deadline', () => {
  it('is one year after the start date', () => {
    expect(paperNoteDeadline('2027-03-15')).toBe('2028-03-15');
    expect(paperNoteDeadline('2028-02-29')).toBe('2029-02-28');
    expect(paperNoteDeadline(undefined)).toBeNull();
  });
});
