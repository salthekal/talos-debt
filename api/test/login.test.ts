/**
 * Login for client staff (step 4.2): email and password, sessions,
 * forgot and reset password, lockout, and the database's protections.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import type { Mail, Mailer } from '../src/login/mailer.js';
import { hashPassword, verifyPassword } from '../src/login/password.js';
import { RateLimiter } from '../src/login/routes.js';
import { ADMIN_URL, API_URL, CLIENT, OWNER, STAFF } from './helpers.js';

const DEV_PASSWORD = 'talos-dev-password';

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail) {
    this.sent.push(m);
  }
  lastLink(): string {
    const m = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(this.sent.at(-1)?.text ?? '');
    return m![1]!;
  }
}

let admin: pg.Pool;
let pool: pg.Pool;
let app: FastifyInstance;
let sessionApp: FastifyInstance;
const mailer = new FakeMailer();

const cookieOf = (res: LightMyRequestResponse) => {
  const raw = res.headers['set-cookie'];
  const line = Array.isArray(raw) ? raw[0]! : String(raw);
  return line.split(';')[0]!;
};
const login = (email: string, password: string, a = app) =>
  a.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: ADMIN_URL });
  pool = createPool(API_URL);
  const storageDir = mkdtempSync(path.join(tmpdir(), 'talos-login-'));
  const base = { NODE_ENV: 'test', DATABASE_URL: API_URL, STORAGE_LOCAL_DIR: storageDir, APP_URL: 'http://localhost:5173' };
  app = buildApp(loadConfig({ ...base, AUTH_MODE: 'dev' }), pool, { mailer, loginLimiter: new RateLimiter(1000, 60_000) });
  sessionApp = buildApp(loadConfig({ ...base, AUTH_MODE: 'session' }), pool, { mailer, loginLimiter: new RateLimiter(1000, 60_000) });
  await app.ready();
  await sessionApp.ready();
});

afterAll(async () => {
  await app?.close();
  await sessionApp?.close();
  await pool?.end();
  await admin?.end();
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterY', h)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    // Two hashes of the same password differ (random salt).
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('logging in', () => {
  it('logs in with email and password and sets a safe cookie', async () => {
    const res = await login('staff@demo.example', DEV_PASSWORD);
    expect(res.statusCode).toBe(200);
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/^talos_session=[A-Za-z0-9_-]{43};/);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Lax');
    expect(res.body).not.toContain('scrypt');

    const me = await app.inject({ url: '/api/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: STAFF, role: 'staff' });
  });

  it('accepts the email in any letter case', async () => {
    expect((await login('  STAFF@Demo.Example ', DEV_PASSWORD)).statusCode).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrong = await login('staff@demo.example', 'not the password');
    const unknown = await login('nobody@demo.example', 'not the password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    await admin.query(`UPDATE auth.credentials SET failed_logins = 0 WHERE user_id = $1`, [STAFF]);
  });

  it('a request that changes something needs the x-talos header', async () => {
    const cookie = cookieOf(await login('staff@demo.example', DEV_PASSWORD));
    const without = await app.inject({ method: 'POST', url: '/api/reminders/approve', headers: { cookie }, payload: { all: true } });
    expect(without.statusCode).toBe(403);
    const withHeader = await app.inject({
      method: 'POST', url: '/api/reminders/approve', headers: { cookie, 'x-talos': '1' }, payload: { all: true },
    });
    expect(withHeader.statusCode).toBe(200);
  });

  it('logging out ends the session', async () => {
    const cookie = cookieOf(await login('staff@demo.example', DEV_PASSWORD));
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-talos': '1' } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('an unknown or forged cookie is refused', async () => {
    const res = await app.inject({ url: '/api/me', headers: { cookie: 'talos_session=forged-value-1234567890-abcdefghijklmnopqrstu' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('session_ended');
  });

  it('a session ends after the idle time and at its absolute end', async () => {
    const cookie = cookieOf(await login('staff@demo.example', DEV_PASSWORD));
    await admin.query(`UPDATE auth.sessions SET last_seen_at = now() - interval '13 hours' WHERE user_id = $1`, [STAFF]);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);

    const cookie2 = cookieOf(await login('staff@demo.example', DEV_PASSWORD));
    await admin.query(`UPDATE auth.sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [STAFF]);
    expect((await app.inject({ url: '/api/me', headers: { cookie: cookie2 } })).statusCode).toBe(401);
  });

  it('a deactivated user, or a suspended client, is logged out at once', async () => {
    const cookie = cookieOf(await login('owner@demo.example', DEV_PASSWORD));
    await admin.query(`UPDATE app.users SET is_active = false WHERE id = $1`, [OWNER]);
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect((await login('owner@demo.example', DEV_PASSWORD)).statusCode).toBe(401);
    await admin.query(`UPDATE app.users SET is_active = true WHERE id = $1`, [OWNER]);

    const cookie2 = cookieOf(await login('owner@demo.example', DEV_PASSWORD));
    await admin.query(`UPDATE app.clients SET status = 'suspended' WHERE id = $1`, [CLIENT]);
    expect((await app.inject({ url: '/api/me', headers: { cookie: cookie2 } })).statusCode).toBe(401);
    await admin.query(`UPDATE app.clients SET status = 'active' WHERE id = $1`, [CLIENT]);
  });

  it('locks the account after 8 wrong passwords, without revealing it to strangers', async () => {
    for (let i = 0; i < 8; i++) expect((await login('owner@demo.example', `wrong-${i}`)).statusCode).toBe(401);
    // Right password while locked: told to wait. Wrong password: the usual answer.
    const right = await login('owner@demo.example', DEV_PASSWORD);
    expect(right.statusCode).toBe(423);
    expect((await login('owner@demo.example', 'wrong-again')).json().error).toBe('wrong_login');
    const audit = await admin.query(`SELECT 1 FROM audit.activity_log WHERE action = 'auth.locked' AND actor_id = $1`, [OWNER]);
    expect(audit.rowCount).toBeGreaterThan(0);
    // After the wait, the right password works again.
    await admin.query(`UPDATE auth.credentials SET locked_until = now() - interval '1 second' WHERE user_id = $1`, [OWNER]);
    expect((await login('owner@demo.example', DEV_PASSWORD)).statusCode).toBe(200);
  });

  it('too many attempts from one address are slowed down', async () => {
    const limited = buildApp(loadConfig({ NODE_ENV: 'test', DATABASE_URL: API_URL }), pool, { mailer, loginLimiter: new RateLimiter(3, 60_000) });
    await limited.ready();
    try {
      for (let i = 0; i < 3; i++) await login('nobody@demo.example', 'x', limited);
      expect((await login('nobody@demo.example', 'x', limited)).statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('with AUTH_MODE=session the development headers are refused', async () => {
    const res = await sessionApp.inject({ url: '/api/me', headers: { 'x-client-id': CLIENT, 'x-user-id': STAFF } });
    expect(res.statusCode).toBe(401);
    const cookie = cookieOf(await login('staff@demo.example', DEV_PASSWORD, sessionApp));
    expect((await sessionApp.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });
});

describe('forgot and reset password', () => {
  it('sends a link to a known email, and the same answer for an unknown one', async () => {
    mailer.sent = [];
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@demo.example' } });
    expect(unknown.statusCode).toBe(202);
    expect(mailer.sent).toHaveLength(0);

    const known = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'Staff@demo.example' } });
    expect(known.statusCode).toBe(202);
    expect(known.json()).toEqual(unknown.json());
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.to).toBe('staff@demo.example');
    expect(mail.subject).toBe('إعادة تعيين كلمة المرور | Reset your password');
    expect(mail.text).toContain('http://localhost:5173/reset-password?token=');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.text).not.toMatch(/—/);
  });

  it('the link sets a new password once, and ends every session', async () => {
    const oldSession = cookieOf(await login('staff@demo.example', DEV_PASSWORD));
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'staff@demo.example' } });
    const token = mailer.lastLink();

    // Only a digest of the token is stored.
    const stored = await admin.query(`SELECT count(*)::int AS n FROM auth.reset_links WHERE encode(token_hash, 'escape') LIKE $1`, [`%${token}%`]);
    expect(stored.rows[0].n).toBe(0);

    const check = await app.inject({ url: `/api/auth/reset?token=${token}` });
    expect(check.json()).toMatchObject({ valid: true, kind: 'reset', email: 'staff@demo.example' });

    const short = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'short' } });
    expect(short.statusCode).toBe(400);

    const done = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'a brand new password' } });
    expect(done.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', headers: { cookie: oldSession } })).statusCode).toBe(401);
    expect((await login('staff@demo.example', DEV_PASSWORD)).statusCode).toBe(401);
    expect((await login('staff@demo.example', 'a brand new password')).statusCode).toBe(200);

    const again = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'another new password' } });
    expect(again.statusCode).toBe(410);
    expect((await app.inject({ url: `/api/auth/reset?token=${token}` })).statusCode).toBe(410);
  });

  it('a newer link replaces an older one, and links expire', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'owner@demo.example' } });
    const first = mailer.lastLink();
    await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'owner@demo.example' } });
    const second = mailer.lastLink();
    expect((await app.inject({ url: `/api/auth/reset?token=${first}` })).statusCode).toBe(410);
    expect((await app.inject({ url: `/api/auth/reset?token=${second}` })).statusCode).toBe(200);
    await admin.query(`UPDATE auth.reset_links SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await app.inject({ url: `/api/auth/reset?token=${second}` })).statusCode).toBe(410);
  });
});

describe('the database protects the login data', () => {
  it('the API account cannot read the auth tables, only call the functions', async () => {
    await expect(pool.query(`SELECT * FROM auth.credentials`)).rejects.toThrow(/permission denied/);
    await expect(pool.query(`SELECT * FROM auth.sessions`)).rejects.toThrow(/permission denied/);
    await expect(pool.query(`SELECT * FROM auth.reset_links`)).rejects.toThrow(/permission denied/);
  });

  it('an email belongs to one person across all clients', async () => {
    await admin.query(
      `INSERT INTO app.clients (id, legal_name, cr_number, owner_name, owner_phone, owner_email, status)
       VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Login Test Client', '0000000066', 'X', '+966500000266', 'x@test.example', 'active')
       ON CONFLICT DO NOTHING`,
    );
    await expect(
      admin.query(
        `INSERT INTO app.users (client_id, full_name, email, role) VALUES ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Copy', 'STAFF@demo.example', 'staff')`,
      ),
    ).rejects.toThrow(/users_email_one_person/);
  });

  it('production refuses development login, plain http and logged email', () => {
    const prod = { NODE_ENV: 'production', DATABASE_URL: API_URL, STORAGE_DRIVER: 'gcs', GCS_BUCKET: 'b', AUTH_MODE: 'session' };
    expect(() => loadConfig({ ...prod, AUTH_MODE: 'dev', APP_URL: 'https://app.talosksa.com', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtps://x' })).toThrow(/AUTH_MODE=dev/);
    expect(() => loadConfig({ ...prod, APP_URL: 'http://app.talosksa.com', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtps://x' })).toThrow(/https/);
    expect(() => loadConfig({ ...prod, APP_URL: 'https://app.talosksa.com' })).toThrow(/MAIL_DRIVER=smtp/);
    expect(() => loadConfig({ ...prod, APP_URL: 'https://app.talosksa.com', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtps://u:p@h:465' })).not.toThrow();
  });
});
