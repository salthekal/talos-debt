import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from '../config.js';
import { parseOr400 } from '../validation.js';
import { linkEmail } from './emails.js';
import type { Mailer } from './mailer.js';
import { PASSWORD_MAX, PASSWORD_MIN, dummyHash, hashPassword, newToken, tokenDigest, verifyPassword } from './password.js';
import { CSRF_HEADER, SESSION_COOKIE, clearSessionCookie, readCookie, sessionCookie } from './session.js';

const RESET_HOURS = 1;
export const INVITE_HOURS = 72;

const email = z.string().trim().toLowerCase().email().max(254);
const loginBody = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX) });
const forgotBody = z.object({ email });
const token = z.string().regex(/^[A-Za-z0-9_-]{40,60}$/, 'invalid link');
const resetBody = z.object({
  token,
  password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX),
});

/**
 * A small limit per address on the login and forgot-password routes, on top
 * of the per-account lock in the database. Kept in memory: enough for one
 * API server; several servers each keep their own count.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}

export interface LoginDeps {
  pool: pg.Pool;
  config: Config;
  mailer: Mailer;
  limiter?: RateLimiter;
}

/** Send a reset (or invitation) link if the email belongs to an active user. Returns whether one was sent. */
export async function sendLink(deps: LoginDeps, to: string, kind: 'reset' | 'invite'): Promise<boolean> {
  const hours = kind === 'invite' ? INVITE_HOURS : RESET_HOURS;
  const t = newToken();
  const { rows } = await deps.pool.query<{ user_id: string; full_name: string; company: string | null }>(
    `SELECT user_id, full_name, company FROM auth.create_reset_link($1, $2, $3, now() + make_interval(hours => $4))`,
    [to, tokenDigest(t), kind, hours],
  );
  const user = rows[0];
  if (!user) return false;
  const link = `${deps.config.APP_URL.replace(/\/$/, '')}/reset-password?token=${t}`;
  await deps.mailer.send(linkEmail({ to, name: user.full_name, link, kind, hours, company: user.company ?? undefined }));
  return true;
}

export function loginRoutes(app: FastifyInstance, deps: LoginDeps) {
  const { pool, config } = deps;
  const limiter = deps.limiter ?? new RateLimiter(20, 5 * 60_000);
  const tooMany = (req: FastifyRequest) => !limiter.allow(`${req.ip}:${req.url.split('?')[0]}`);
  const WRONG = { error: 'wrong_login', message: 'Email or password is wrong.' };

  app.post('/api/auth/login', async (req, reply) => {
    if (tooMany(req)) return reply.code(429).send({ error: 'too_many', message: 'Too many attempts. Wait a few minutes.' });
    const body = parseOr400(loginBody, req.body ?? {}, reply);
    if (!body) return;

    const { rows } = await pool.query<{ user_id: string; client_id: string; password_hash: string | null; locked_until: Date | null; can_log_in: boolean }>(
      `SELECT user_id, client_id, password_hash, locked_until, can_log_in FROM auth.login_info($1)`,
      [body.email],
    );
    const u = rows[0];
    // Same work whether or not the email exists, so timing does not reveal it.
    const ok = await verifyPassword(body.password, u?.password_hash ?? (await dummyHash()));
    if (!u || !u.password_hash) return reply.code(401).send(WRONG);
    if (u.locked_until && u.locked_until > new Date()) {
      // Say "locked" only to someone who knows the password, so it cannot reveal which emails exist.
      return ok
        ? reply.code(423).send({ error: 'locked', message: 'Too many wrong passwords. Try again in a few minutes, or reset your password.' })
        : reply.code(401).send(WRONG);
    }
    await pool.query(`SELECT auth.record_login($1, $2, $3, $4)`, [u.user_id, ok, config.LOGIN_LOCK_AFTER, config.LOGIN_LOCK_MINUTES]);
    if (!ok || !u.can_log_in) return reply.code(401).send(WRONG);

    const t = newToken();
    const maxAge = config.SESSION_MAX_DAYS * 86_400;
    await pool.query(`SELECT auth.create_session($1, $2, now() + make_interval(secs => $3), $4, $5)`, [
      u.user_id,
      tokenDigest(t),
      maxAge,
      req.ip || null,
      String(req.headers['user-agent'] ?? '').slice(0, 300),
    ]);
    reply.header('set-cookie', sessionCookie(config, t, maxAge));
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = readCookie(req, SESSION_COOKIE);
    if (t) {
      if (req.headers[CSRF_HEADER] !== '1') return reply.code(403).send({ error: 'missing_header' });
      await pool.query(`SELECT auth.end_session($1)`, [tokenDigest(t)]);
    }
    reply.header('set-cookie', clearSessionCookie(config));
    return { ok: true };
  });

  // Always the same answer, so it cannot be used to find out who has an account.
  app.post('/api/auth/forgot', async (req, reply) => {
    if (tooMany(req)) return reply.code(429).send({ error: 'too_many', message: 'Too many attempts. Wait a few minutes.' });
    const body = parseOr400(forgotBody, req.body ?? {}, reply);
    if (!body) return;
    try {
      await sendLink(deps, body.email, 'reset');
    } catch (err) {
      req.log.error({ err }, 'reset email failed');
    }
    return reply.code(202).send({ ok: true });
  });

  app.get('/api/auth/reset', async (req, reply) => {
    const q = parseOr400(z.object({ token }), req.query ?? {}, reply);
    if (!q) return;
    const { rows } = await pool.query<{ kind: string; full_name: string; email: string }>(
      `SELECT kind, full_name, email FROM auth.check_reset_link($1)`,
      [tokenDigest(q.token)],
    );
    if (!rows[0]) return reply.code(410).send({ error: 'link_expired', message: 'This link has expired or was already used.' });
    return { valid: true, kind: rows[0].kind, fullName: rows[0].full_name, email: rows[0].email };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    if (tooMany(req)) return reply.code(429).send({ error: 'too_many', message: 'Too many attempts. Wait a few minutes.' });
    const body = parseOr400(resetBody, req.body ?? {}, reply);
    if (!body) return;
    const hash = await hashPassword(body.password);
    const { rows } = await pool.query<{ user_id: string | null }>(`SELECT auth.use_reset_link($1, $2) AS user_id`, [
      tokenDigest(body.token),
      hash,
    ]);
    if (!rows[0]?.user_id) return reply.code(410).send({ error: 'link_expired', message: 'This link has expired or was already used.' });
    return { ok: true };
  });
}
