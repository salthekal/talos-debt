import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Passwords and tokens.
 *
 * Passwords are hashed here with scrypt (memory-hard, built into Node), so
 * the database only ever sees the hash. Stored as
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 * so the cost can be raised later and old hashes still verify.
 */

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * N * R * 2;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: Math.max(MAXMEM, 128 * n * r * 2) };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A hash to check against when the email is unknown, so both cases take the same time. */
let dummy: Promise<string> | undefined;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(12).toString('base64'));
  return dummy;
}

/** A random token for a cookie or a link (256 bits, URL safe). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores for a token: its SHA-256 digest, never the token. */
export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Simple rules people can follow; length matters most. */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
