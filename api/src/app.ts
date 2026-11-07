import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { devAuth } from './auth.js';
import type { Config } from './config.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { messageRoutes } from './routes/messages.js';
import { paymentRoutes } from './routes/payments.js';
import { GeminiClient, type LlmClient } from './ai/llm.js';
import { webhookRoutes } from './routes/webhooks.js';
import { MetaCloudSender, type WhatsAppSender } from './whatsapp/client.js';

export interface AppDeps {
  /** WhatsApp sender; defaults to Meta when WHATSAPP_TOKEN is set. Tests pass a fake. */
  whatsapp?: WhatsAppSender;
  /** Clock, so tests can check working hours. */
  now?: () => Date;
  /** Worker connection (talos_worker). Without it the WhatsApp webhook is not mounted. */
  workerPool?: pg.Pool;
  /** AI model; defaults to the configured provider. Tests pass a fake. */
  llm?: LlmClient;
  /** Process webhook events before answering Meta (tests only). */
  processWebhooksInline?: boolean;
}

export function buildApp(config: Config, pool: pg.Pool, deps: AppDeps = {}): FastifyInstance {
  // Fastify logs method, URL and status only, never request bodies (debtor data).
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.LOG_LEVEL },
  });

  const whatsapp =
    deps.whatsapp ??
    (config.WHATSAPP_TOKEN ? new MetaCloudSender(config.WHATSAPP_TOKEN, config.WHATSAPP_API_VERSION) : undefined);
  const now = deps.now ?? (() => new Date());
  const outbound = { pool, config, sender: whatsapp, now };
  const llm =
    deps.llm ??
    (config.AI_PROVIDER === 'gemini' && config.AI_API_KEY
      ? new GeminiClient(config.AI_API_KEY, config.AI_MODEL, config.AI_FREE_TIER)
      : undefined);

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database_unavailable' });
    }
  });

  // Everything under /api needs a logged-in user of a client.
  app.register(async (api) => {
    api.addHook('preHandler', devAuth(pool));
    dashboardRoutes(api, pool);
    paymentRoutes(api, pool);
    messageRoutes(api, outbound);
  });

  // Meta's webhook: no user login; requests are checked by signature instead.
  if (deps.workerPool) {
    const inbound = { pool, workerPool: deps.workerPool, config, sender: whatsapp, llm, now };
    app.register(async (hooks) => webhookRoutes(hooks, inbound, { processInline: deps.processWebhooksInline }));
  }

  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'request failed');
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message ?? 'Bad request' });
    }
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  return app;
}
