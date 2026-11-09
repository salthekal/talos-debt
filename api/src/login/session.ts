import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Role } from '../auth.js';
import { devAuth } from '../auth.js';
import type { Config } from '../config.js';
import { tokenDigest } from './password.js';

export const SESSION_COOKIE = 'talos_session';
/** Every request that changes something must carry this header. Other sites cannot add it. */
export const CSRF_HEADER = 'x-talos';

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(config: Config, value: string, maxAgeSeconds: number): string {
  const secure = config.APP_URL.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearSessionCookie(config: Config): string {
  return sessionCookie(config, '', 0);
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Who is calling. A session cookie (email and password login) always works.
 * With AUTH_MODE=dev, the x-client-id / x-user-id headers also work (tests
 * and scripts); production refuses AUTH_MODE=dev.
 *
 * Requests that change something with a cookie must also send `x-talos: 1`.
 * Browsers do not let other sites add that header, so a page elsewhere
 * cannot act as the logged-in user (cross-site request forgery).
 */
export function authenticate(pool: pg.Pool, config: Config) {
  const dev = devAuth(pool);
  return async function check(req: FastifyRequest, reply: FastifyReply) {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) {
      const { rows } = await pool.query<{ user_id: string; client_id: string; full_name: string; role: Role }>(
        `SELECT user_id, client_id, full_name, role FROM auth.session_user($1, $2)`,
        [tokenDigest(token), config.SESSION_IDLE_MINUTES],
      );
      const s = rows[0];
      if (!s) {
        reply.header('set-cookie', clearSessionCookie(config));
        return reply.code(401).send({ error: 'session_ended', message: 'Your session ended. Log in again.' });
      }
      if (UNSAFE.has(req.method) && req.headers[CSRF_HEADER] !== '1') {
        return reply.code(403).send({ error: 'missing_header', message: `Send the ${CSRF_HEADER}: 1 header` });
      }
      req.user = { clientId: s.client_id, userId: s.user_id, role: s.role, fullName: s.full_name };
      return;
    }
    if (config.AUTH_MODE === 'dev' && (req.headers['x-client-id'] || req.headers['x-user-id'])) {
      return dev(req, reply);
    }
    return reply.code(401).send({ error: 'unauthorized', message: 'Log in first.' });
  };
}
