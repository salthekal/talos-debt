import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertRlsEnforced, createPool } from './db.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
await assertRlsEnforced(pool);

const app = buildApp(config, pool);

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: config.HOST });
