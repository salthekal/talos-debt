/**
 * Najiz runs in the database (migration 0009): one sign-in to Najiz for one
 * client, and the notes it files (`najiz_run_items`).
 *
 * The dashboard creates a run and reads it (inside withTenant). The Najiz
 * worker claims runs and recovers runs whose worker stopped answering; those
 * two are the only things done on the worker connection, across clients.
 */
import type pg from 'pg';
import type { Db } from '../db.js';
import type { StopReason } from './site.js';

export const ACTIVE_STAGES = ['starting', 'waiting_nafath', 'working'];

export interface ClaimedRun {
  id: string;
  client_id: string;
  kind: 'file' | 'status_check';
  requested_by: string;
}

/** What the dashboard shows of a run. Never the owner's ID number, never session data. */
export async function loadRunView(db: Db, runId: string) {
  const run = (
    await db.query(
      `SELECT r.id, r.kind, r.stage, r.nafath_number, r.nafath_expires_at, r.stop_reason, r.created_at AS started_at,
              r.finished_at, right(c.owner_phone, 4) AS owner_phone_last4
         FROM app.najiz_runs r JOIN app.clients c ON c.id = r.client_id
        WHERE r.id = $1`,
      [runId],
    )
  ).rows[0];
  if (!run) return undefined;
  const items = await db.query(
    `SELECT l.debt_id, dr.full_name, d.ref_code, l.amount_claimed AS amount, ri.step, ri.request_number,
            ri.najiz_status, ri.error
       FROM app.najiz_run_items ri
       JOIN app.legal_cases l ON l.id = ri.legal_case_id
       JOIN app.debts d ON d.id = l.debt_id
       JOIN app.debtors dr ON dr.id = d.debtor_id
      WHERE ri.run_id = $1
      ORDER BY ri.position`,
    [runId],
  );
  return {
    ...run,
    // The Nafath number is not sent to the owner by WhatsApp yet: that needs a template approved by Meta (step 1.10).
    nafath_sent: false,
    cases: items.rows,
  };
}

/**
 * Take the oldest new run that no worker has, in one statement.
 * FOR UPDATE SKIP LOCKED: two workers never take the same run.
 */
export async function claimRun(workerPool: pg.Pool, workerId: string): Promise<ClaimedRun | null> {
  const { rows } = await workerPool.query<ClaimedRun>(
    `UPDATE app.najiz_runs r
        SET claimed_by = $1, heartbeat_at = now()
      WHERE r.id = (SELECT id FROM app.najiz_runs
                     WHERE stage = 'starting' AND claimed_by IS NULL
                     ORDER BY created_at LIMIT 1
                     FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.client_id, r.kind, r.requested_by`,
    [workerId],
  );
  return rows[0] ?? null;
}

/** The worker is still working on this run. */
export async function heartbeat(workerPool: pg.Pool, runId: string) {
  await workerPool.query(`UPDATE app.najiz_runs SET heartbeat_at = now() WHERE id = $1 AND stage = ANY($2)`, [runId, ACTIVE_STAGES]);
}

/**
 * Runs whose worker stopped answering for `staleMinutes` (a crash, a restart),
 * or that no worker took in that time, are stopped and staff are told.
 *
 * A note whose "send" may have been pressed keeps the step 'sending': it may
 * be on Najiz, so Talos will not file it again until staff have checked
 * (see POST /api/najiz/runs). Every other unfinished note is 'stopped'.
 */
export async function recoverLostRuns(workerPool: pg.Pool, staleMinutes: number): Promise<number> {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    const lost = (
      await client.query<{ id: string; client_id: string }>(
        `SELECT id, client_id FROM app.najiz_runs
          WHERE stage = ANY($1) AND coalesce(heartbeat_at, created_at) < now() - make_interval(mins => $2)
          FOR UPDATE SKIP LOCKED`,
        [ACTIVE_STAGES, staleMinutes],
      )
    ).rows;
    for (const r of lost) {
      await client.query(
        `UPDATE app.najiz_runs
            SET stage = 'stopped', stop_reason = 'worker_lost', nafath_number = NULL, finished_at = now(),
                stop_detail = 'Talos stopped answering during this Najiz sign-in'
          WHERE id = $1`,
        [r.id],
      );
      const maybe = await client.query(
        `UPDATE app.najiz_run_items
            SET error = 'Talos stopped while sending. Check on Najiz whether this request was sent.', updated_at = now()
          WHERE run_id = $1 AND step = 'sending'
          RETURNING id`,
        [r.id],
      );
      await client.query(
        `UPDATE app.najiz_run_items SET step = 'stopped', updated_at = now()
          WHERE run_id = $1 AND step NOT IN ('sent', 'checked', 'stopped', 'sending')`,
        [r.id],
      );
      await client.query(
        `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data)
         VALUES ($1, 'system', $2, 'app.najiz_runs', $3, $4)`,
        [
          r.client_id,
          'The Najiz sign-in stopped before it finished.',
          r.id,
          JSON.stringify({ event: 'najiz_stopped', reason: 'worker_lost', maybe_sent: maybe.rowCount ?? 0 }),
        ],
      );
    }
    await client.query('COMMIT');
    return lost.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** True when the run was stopped or finished (for example staff pressed stop). */
export async function isFinished(db: Db, runId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT stage FROM app.najiz_runs WHERE id = $1`, [runId]);
  return !rows[0] || !ACTIVE_STAGES.includes(rows[0].stage);
}

/** Stop a run that is still going. Returns false when it had already ended. */
export async function stopRun(db: Db, runId: string, reason: StopReason, detail: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE app.najiz_runs
        SET stage = 'stopped', stop_reason = $2, stop_detail = $3, nafath_number = NULL, finished_at = now()
      WHERE id = $1 AND stage = ANY($4)`,
    [runId, reason, detail, ACTIVE_STAGES],
  );
  if (!rowCount) return false;
  await db.query(
    `UPDATE app.najiz_run_items SET step = 'stopped', updated_at = now()
      WHERE run_id = $1 AND step IN ('waiting', 'request_type', 'requester', 'debtor', 'content')`,
    [runId],
  );
  return true;
}
