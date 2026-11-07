import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // The API connects as a login role that is a member of talos_app (RLS applies).
  DATABASE_URL: z.string().min(1),
  // 'dev' trusts the x-client-id and x-user-id headers. Never allowed in production.
  AUTH_MODE: z.enum(['dev']).default('dev'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // WhatsApp Cloud API (Meta). Keep the token only in .env, never in git.
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  // Development only: send from this phone number id instead of the one stored
  // on the client's sender number (the seed uses a placeholder).
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  // Development only: every outbound message goes to this number instead of the
  // debtor's, so fake debtors never receive anything. Required outside production.
  WHATSAPP_DEV_REDIRECT_TO: z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'must be +country number').optional(),
  // Development only: use this approved template instead of the stored one,
  // as "name:language", e.g. "hello_world:en_US" (Meta's test template).
  WHATSAPP_DEV_TEMPLATE: z.string().regex(/^[a-z0-9_]+:[A-Za-z_]+$/, 'must be name:language').optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && config.AUTH_MODE === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production. Set up real login first.');
  }
  if (
    config.NODE_ENV === 'production' &&
    (config.WHATSAPP_DEV_REDIRECT_TO || config.WHATSAPP_DEV_TEMPLATE || config.WHATSAPP_PHONE_NUMBER_ID)
  ) {
    throw new Error('WHATSAPP_DEV_* and WHATSAPP_PHONE_NUMBER_ID overrides are not allowed in production.');
  }
  return config;
}
