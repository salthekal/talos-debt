import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertRlsEnforced, assertWorkerRole, createPool } from './db.js';
import { createStorage } from './storage/storage.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await assertRlsEnforced(pool);

const workerPool = config.WORKER_DATABASE_URL ? createPool(config.WORKER_DATABASE_URL) : undefined;
if (workerPool) await assertWorkerRole(workerPool);

const storage = await createStorage(config);
const app = buildApp(config, pool, { workerPool, storage });
if (config.STORAGE_DRIVER === 'local') app.log.warn(`Files are stored on this machine in ${config.STORAGE_LOCAL_DIR} (development only)`);
if (!workerPool) app.log.warn('WORKER_DATABASE_URL is not set: the WhatsApp webhook is off');
if (config.AI_PROVIDER === 'none') app.log.warn('AI_PROVIDER is not set: incoming messages are saved but not answered');

const shutdown = async () => {
  await app.close();
  await pool.end();
  await workerPool?.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
