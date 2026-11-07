/**
 * Runs before each test file: rebuild talos_test from the migrations and the
 * fake seed data, so no test file depends on what another one changed.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/db-reset.sh', import.meta.url));
execFileSync(script, { env: { ...process.env, DB_NAME: 'talos_test' }, stdio: 'ignore' });
