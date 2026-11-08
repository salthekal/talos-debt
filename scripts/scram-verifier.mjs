// Turn a password (read from standard input) into a PostgreSQL
// SCRAM-SHA-256 verifier, the same format PostgreSQL stores itself.
// Sending the verifier instead of the password means the real password
// never reaches the database server or its logs.
//
//   printf '%s' "$PASSWORD" | node scripts/scram-verifier.mjs
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const password = Buffer.concat(chunks).toString('utf8');
if (!password) {
  console.error('No password on standard input');
  process.exit(1);
}

const iterations = 4096;
const salt = randomBytes(16);
const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
const clientKey = createHmac('sha256', salted).update('Client Key').digest();
const storedKey = createHash('sha256').update(clientKey).digest();
const serverKey = createHmac('sha256', salted).update('Server Key').digest();

process.stdout.write(
  `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`,
);
