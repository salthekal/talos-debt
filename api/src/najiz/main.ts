/**
 * The Najiz worker process: `npm run najiz` (keeps running), or
 * `npm run najiz -- --once` (one round, then exit).
 *
 * It needs DATABASE_URL (talos_api, all client work under RLS) and
 * WORKER_DATABASE_URL (talos_jobs, to find and claim runs across clients),
 * and Chromium (`npx playwright install --with-deps chromium`).
 * Run one or more next to the API server.
 */
import { loadConfig } from '../config.js';
import { assertRlsEnforced, assertWorkerRole, createPool } from '../db.js';
import { createStorage } from '../storage/storage.js';
import { PlaywrightNajizSite, sharedChromium } from './robot.js';
import { NajizWorker } from './worker.js';

const once = process.argv.includes('--once');
const config = loadConfig();
if (!config.WORKER_DATABASE_URL) {
  console.error('WORKER_DATABASE_URL is required for the Najiz worker (the talos_jobs connection).');
  process.exit(1);
}

const pool = createPool(config.DATABASE_URL);
const workerPool = createPool(config.WORKER_DATABASE_URL);
await assertRlsEnforced(pool);
await assertWorkerRole(workerPool);
const storage = await createStorage(config);
const chromium = sharedChromium();

// Najiz rule 3: never log session data. Only plain words and ids go to the log.
const log = {
  info: (o: object, msg: string) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg, ...o })),
  error: (o: object, msg: string) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg, ...o })),
};

const worker = new NajizWorker({
  pool, workerPool, storage,
  site: () => new PlaywrightNajizSite({ baseUrl: config.NAJIZ_URL, browser: chromium.get }),
  nafathSeconds: config.NAJIZ_NAFATH_SECONDS,
  staleMinutes: config.NAJIZ_STALE_MINUTES,
  pollMs: config.NAJIZ_POLL_SECONDS * 1000,
  now: () => new Date(),
  log,
});

const close = async () => {
  await worker.stop();
  await chromium.close();
  await pool.end();
  await workerPool.end();
};

if (once) {
  const r = await worker.tick();
  log.info(r, 'najiz: one round done');
  await close();
} else {
  log.info({ najiz: config.NAJIZ_URL, worker: worker.id }, 'najiz worker started');
  const shutdown = async () => {
    log.info({}, 'najiz worker stopping');
    await close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  worker.start(config.NAJIZ_POLL_SECONDS * 1000);
}
