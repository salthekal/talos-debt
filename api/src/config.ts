import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  // The API connects as a login role that is a member of talos_app (RLS applies).
  DATABASE_URL: z.string().min(1),
  // Login. Staff always log in with email and password (a session cookie).
  // 'dev' also trusts the x-client-id and x-user-id headers (tests, scripts). Never allowed in production.
  AUTH_MODE: z.enum(['dev', 'session']).default('dev'),
  // Where the dashboard runs; links in emails point here. Must be https in production.
  APP_URL: z.string().url().default('http://localhost:5173'),
  // A session ends after this long without activity, and after SESSION_MAX_DAYS in any case.
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(12 * 60),
  SESSION_MAX_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // After this many wrong passwords in a row, the account waits LOGIN_LOCK_MINUTES.
  LOGIN_LOCK_AFTER: z.coerce.number().int().min(3).max(50).default(8),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(15),
  // Emails (password reset, invitations). 'log' writes them to api/.data/mail (development only).
  MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),
  SMTP_URL: z.string().optional(), // smtps://user:password@host:465
  MAIL_FROM: z.string().default('Talos <no-reply@talosksa.com>'),
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

  // Scheduler (Phase 2, `npm run scheduler`).
  SCHEDULER_POLL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),
  SCHEDULER_PLAN_EVERY_SECONDS: z.coerce.number().int().min(10).max(86400).default(300),
  // A task still 'running' after this long was stopped half way and is recovered.
  SCHEDULER_STALE_MINUTES: z.coerce.number().int().min(2).max(1440).default(10),
  // Daily summary for each client from this time (client's own time zone), on working days.
  DAILY_SUMMARY_TIME: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM')
    .default('08:00'),

  // Najiz worker (Phase 5.4, `npm run najiz`).
  NAJIZ_URL: z.url().default('https://najiz.sa'),
  // How long the owner has to choose the number in the Nafath app.
  NAJIZ_NAFATH_SECONDS: z.coerce.number().int().min(30).max(900).default(180),
  // A run whose worker has not written for this long was stopped half way.
  NAJIZ_STALE_MINUTES: z.coerce.number().int().min(2).max(120).default(5),
  NAJIZ_POLL_SECONDS: z.coerce.number().int().min(1).max(300).default(3),

  // Uploaded files (step 3.3). 'local' is a folder on this machine: development
  // and tests only. Production uses a private Google Cloud Storage bucket in
  // the Dammam region (docs/file-storage.md).
  STORAGE_DRIVER: z.enum(['local', 'gcs']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.data/files'),
  GCS_BUCKET: z.string().optional(),
  // Optional Cloud KMS key for the bucket, e.g. projects/p/locations/me-central2/keyRings/r/cryptoKeys/k
  GCS_KMS_KEY: z.string().optional(),
  // Largest document a user can upload, in megabytes. Excel imports have their own 5 MB limit.
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(10),

  // Start date of the new Enforcement Law (YYYY-MM-DD), once it is published.
  // Paper promissory notes and bills of exchange stay enforceable for one year
  // after it. Leave empty while the date is unknown: those notes are still
  // flagged, with no deadline yet.
  ENFORCEMENT_LAW_START_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
    .optional()
    .or(z.literal('').transform(() => undefined)),
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
    throw new Error('AUTH_MODE=dev is not allowed in production. Use AUTH_MODE=session.');
  }
  if (config.NODE_ENV === 'production' && !config.APP_URL.startsWith('https://')) {
    throw new Error('APP_URL must be https in production (login cookies and email links depend on it).');
  }
  if (config.NODE_ENV === 'production' && config.MAIL_DRIVER !== 'smtp') {
    throw new Error('MAIL_DRIVER=smtp is required in production, so password reset emails really go out.');
  }
  if (config.MAIL_DRIVER === 'smtp' && !config.SMTP_URL) {
    throw new Error('SMTP_URL is required when MAIL_DRIVER=smtp.');
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
  if (config.NODE_ENV === 'production' && config.STORAGE_DRIVER !== 'gcs') {
    throw new Error(
      'STORAGE_DRIVER=local is not allowed in production: files must go to the private bucket in Saudi Arabia (STORAGE_DRIVER=gcs).',
    );
  }
  if (config.STORAGE_DRIVER === 'gcs' && !config.GCS_BUCKET) {
    throw new Error('GCS_BUCKET is required when STORAGE_DRIVER=gcs.');
  }
  if (config.NODE_ENV === 'production' && config.WORKER_DATABASE_URL && !config.WHATSAPP_APP_SECRET) {
    throw new Error('WHATSAPP_APP_SECRET is required in production to check webhook signatures.');
  }
  return config;
}
