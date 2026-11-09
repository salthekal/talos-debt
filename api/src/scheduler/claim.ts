import type pg from 'pg';

export type TaskType = 'send_reminder' | 'promise_check' | 'call' | 'mark_legal_ready';

export interface ClaimedTask {
  id: string;
  client_id: string;
  debt_id: string;
  task_type: TaskType;
  attempt_number: number | null;
  tries: number;
  created_at: Date;
}

/**
 * Take up to `limit` due tasks and mark them 'running', in one statement.
 *
 * FOR UPDATE SKIP LOCKED means two workers running at the same time never
 * take the same task: each one skips the rows the other has locked.
 *
 * Reminders are only taken when WhatsApp sending is set up (`canSend`), and
 * only for clients with auto_send on, or when a staff member approved them.
 * Suspended or closed clients get nothing.
 */
export async function claimTasks(
  workerPool: pg.Pool,
  opts: { now: Date; limit: number; canSend: boolean },
): Promise<ClaimedTask[]> {
  const { rows } = await workerPool.query<ClaimedTask>(
    `WITH due AS (
       SELECT t.id
         FROM app.follow_up_tasks t
         JOIN app.clients c ON c.id = t.client_id AND c.status = 'active'
         LEFT JOIN app.follow_up_rules r ON r.client_id = t.client_id
        WHERE t.status = 'pending' AND t.due_at <= $1
          AND (t.task_type <> 'send_reminder'
               OR ($3 AND (coalesce(r.auto_send, false) OR t.approved_at IS NOT NULL)))
        ORDER BY t.due_at
        LIMIT $2
        FOR UPDATE OF t SKIP LOCKED
     )
     UPDATE app.follow_up_tasks t
        SET status = 'running', locked_at = now()
       FROM due
      WHERE t.id = due.id
     RETURNING t.id, t.client_id, t.debt_id, t.task_type, t.attempt_number, t.tries, t.created_at`,
    [opts.now, opts.limit, opts.canSend],
  );
  return rows;
}

export interface Recovered {
  /** Put back to 'pending': nothing had been sent. */
  requeued: number;
  /** A reminder was found already saved, so the task is closed instead of sending again. */
  closed: number;
}

/**
 * Tasks left 'running' longer than `staleMinutes` were stopped half way,
 * for example by a crash or a restart. Put them back without ever sending
 * a reminder twice:
 *
 *  - promise checks and legal steps do all their work in one transaction
 *    with finishing the task, so if they are still 'running' nothing was
 *    saved: they go back to 'pending'.
 *  - a reminder may have been saved as a message before the worker stopped.
 *    If a message for that debt was created after the task was taken, the
 *    task is closed with that message ('done' if it was sent, 'failed' if
 *    it never left 'queued', and staff are told to check it). Otherwise
 *    nothing was saved and it goes back to 'pending'.
 */
export async function recoverStaleTasks(workerPool: pg.Pool, staleMinutes: number): Promise<Recovered> {
  const client = await workerPool.connect();
  try {
    await client.query('BEGIN');
    const stale = (
      await client.query<{ id: string; client_id: string; debt_id: string; task_type: TaskType; locked_at: Date }>(
        `SELECT id, client_id, debt_id, task_type, locked_at
           FROM app.follow_up_tasks
          WHERE status = 'running' AND locked_at < now() - make_interval(mins => $1)
          FOR UPDATE SKIP LOCKED`,
        [staleMinutes],
      )
    ).rows;

    let requeued = 0;
    let closed = 0;
    for (const t of stale) {
      const message =
        t.task_type === 'send_reminder'
          ? (
              await client.query<{ id: string; status: string; ref_code: string }>(
                `SELECT m.id, m.status, d.ref_code
                   FROM app.messages m JOIN app.debts d ON d.id = m.debt_id
                  WHERE m.debt_id = $1 AND m.direction = 'outbound' AND m.template_id IS NOT NULL
                    AND m.created_at >= $2
                  ORDER BY m.created_at LIMIT 1`,
                [t.debt_id, t.locked_at],
              )
            ).rows[0]
          : undefined;

      if (!message) {
        await client.query(
          `UPDATE app.follow_up_tasks SET status = 'pending', locked_at = NULL, last_error = 'worker_stopped' WHERE id = $1`,
          [t.id],
        );
        requeued++;
        continue;
      }

      const sent = message.status !== 'queued' && message.status !== 'failed';
      await client.query(
        `UPDATE app.follow_up_tasks
            SET status = $2, result_message_id = $3, finished_at = now(),
                last_error = CASE WHEN $2 = 'failed' THEN 'worker_stopped_during_send' ELSE last_error END
          WHERE id = $1`,
        [t.id, sent ? 'done' : 'failed', message.id],
      );
      if (message.status === 'queued') {
        // We cannot know whether Meta received it, so it is never sent again automatically.
        await client.query(
          `UPDATE app.messages SET status = 'failed', error_code = 'worker_stopped' WHERE id = $1 AND status = 'queued'`,
          [message.id],
        );
        await client.query(
          `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data)
           VALUES ($1, 'system', $2, 'app.debts', $3, $4)`,
          [
            t.client_id,
            `Reminder for ${message.ref_code} may not have been sent (the system stopped while sending). Check before sending again.`,
            t.debt_id,
            JSON.stringify({ event: 'maybe_not_sent', ref: message.ref_code }),
          ],
        );
      }
      closed++;
    }
    await client.query('COMMIT');
    return { requeued, closed };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
