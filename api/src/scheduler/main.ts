/**
 * The scheduler process: `npm run scheduler` (keeps running), or
 * `npm run scheduler -- --once` (one round, then exit; handy in development).
 *
 * It needs both connections: DATABASE_URL (talos_api, all client work under
 * RLS) and WORKER_DATABASE_URL (talos_jobs, to find and claim work across
 * clients). Run it next to the API server, not inside it.
 */
import { loadConfig } from '../config.js';
import { assertRlsEnforced, assertWorkerRole, createPool } from '../db.js';
import { MetaCloudSender } from '../whatsapp/client.js';
import { Scheduler } from './scheduler.js';

const once = process.argv.includes('--once');
const config = loadConfig();
if (!config.WORKER_DATABASE_URL) {
  console.error('WORKER_DATABASE_URL is required for the scheduler (the talos_jobs connection).');
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL);
const workerPool = createPool(config.WORKER_DATABASE_URL);
await assertRlsEnforced(pool);
await assertWorkerRole(workerPool);

const sender = config.WHATSAPP_TOKEN ? new MetaCloudSender(config.WHATSAPP_TOKEN, config.WHATSAPP_API_VERSION) : undefined;
const log = {
  info: (o: object, msg: string) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg, ...o })),
  error: (o: object, msg: string) =>
    console.error(
      JSON.stringify({ level: 'error', time: new Date().toISOString(), msg, ...o }, (_k, v) =>
        v instanceof Error ? { message: v.message } : v,
      ),
    ),
};

const scheduler = new Scheduler({ pool, workerPool, config, sender, now: () => new Date(), log });
if (!scheduler.canSend()) {
  log.info({}, 'WhatsApp is not set up (WHATSAPP_TOKEN, or WHATSAPP_DEV_REDIRECT_TO outside production): reminders wait, other tasks run');
}

const close = async () => {
  await scheduler.stop();
  await pool.end();
  await workerPool.end();
};

if (once) {
  const result = await scheduler.tick({ plan: true });
  log.info(
    { recovered: result.recovered, planned: result.planned, summaries: result.summaries, ran: result.ran },
    'scheduler: one round done',
  );
  await close();
} else {
  log.info({ every_seconds: config.SCHEDULER_POLL_SECONDS }, 'scheduler started');
  const shutdown = async () => {
    log.info({}, 'scheduler stopping');
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  scheduler.start();
}
