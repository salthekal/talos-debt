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
  // Incoming webhook: Meta signs every request with the app secret, and checks
  // the verify token once when the webhook is set up.
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),

  // The worker connection (member of talos_worker, sees all clients). Only used to
  // store raw webhooks and find which client a phone number belongs to.
  WORKER_DATABASE_URL: z.string().optional(),

  // AI model for the WhatsApp agent.
  AI_PROVIDER: z.enum(['gemini', 'none']).default('none'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('gemini-2.5-flash'),
  // Free tiers may use what we send to improve the provider's models.
  // Allowed for fake development data only; refused in production.
  AI_FREE_TIER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Reply to a debtor's message outside the client's working hours?
  // Reminders always respect working hours. Default: no, the reply waits for staff.
  AGENT_REPLY_OUTSIDE_HOURS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
  if (config.NODE_ENV === 'production' && config.AI_PROVIDER !== 'none' && config.AI_FREE_TIER) {
    throw new Error(
      'A free AI tier is not allowed in production: it may use debtor data for training. Use a paid key and set AI_FREE_TIER=false.',
    );
  }
  if (config.AI_PROVIDER !== 'none' && !config.AI_API_KEY) {
    throw new Error('AI_API_KEY is required when AI_PROVIDER is set.');
  }
  if (config.NODE_ENV === 'production' && config.WORKER_DATABASE_URL && !config.WHATSAPP_APP_SECRET) {
    throw new Error('WHATSAPP_APP_SECRET is required in production to check webhook signatures.');
  }
  return config;
}
