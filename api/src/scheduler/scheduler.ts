import type pg from 'pg';
import type { Config } from '../config.js';
import type { WhatsAppSender } from '../whatsapp/client.js';
import { claimTasks, recoverStaleTasks, type Recovered } from './claim.js';
import { planTasks, type PlanResult } from './planner.js';
import { sendDailySummaries } from './summary.js';
import { runTask, type TaskOutcome } from './tasks.js';

export interface SchedulerDeps {
  /** API pool (talos_api, RLS applies): all work on client data. */
  pool: pg.Pool;
  /** Worker pool (talos_worker): only to find and claim work across clients. */
  workerPool: pg.Pool;
  config: Config;
  sender: WhatsAppSender | undefined;
  now: () => Date;
  log?: { info: (o: object, msg: string) => void; error: (o: object, msg: string) => void };
}

export interface TickResult {
  recovered: Recovered;
  planned?: PlanResult;
  ran: { id: string; type: string; outcome: TaskOutcome }[];
  summaries: number;
}

/**
 * The scheduler. Each tick:
 *   1. puts back tasks a stopped worker left half done (never sending twice),
 *   2. plans next steps for debts that have none (every few minutes),
 *   3. takes due tasks and runs them one at a time,
 *   4. sends the daily summaries that are due.
 *
 * Several workers can run at once: claiming uses SKIP LOCKED, planning takes
 * an advisory lock, and the database allows only one open reminder per debt.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;
  private lastPlan = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  /** WhatsApp sending is set up, including the development redirect. */
  canSend(): boolean {
    const { config, sender } = this.deps;
    return Boolean(sender) && (config.NODE_ENV === 'production' || Boolean(config.WHATSAPP_DEV_REDIRECT_TO));
  }

  async tick(opts: { plan?: boolean } = {}): Promise<TickResult> {
    const { config, now } = this.deps;
    const recovered = await recoverStaleTasks(this.deps.workerPool, config.SCHEDULER_STALE_MINUTES);

    let planned: PlanResult | undefined;
    const due = now().getTime() - this.lastPlan >= config.SCHEDULER_PLAN_EVERY_SECONDS * 1000;
    if (opts.plan ?? due) {
      planned = await planTasks(this.deps);
      this.lastPlan = now().getTime();
    }

    const ran: TickResult['ran'] = [];
    const tasks = await claimTasks(this.deps.workerPool, {
      now: now(),
      limit: config.SCHEDULER_BATCH_SIZE,
      canSend: this.canSend(),
    });
    // One at a time, so a client's reminders go out in order and Meta's rate limits are respected.
    for (const task of tasks) {
      const outcome = await runTask(this.deps, task);
      ran.push({ id: task.id, type: task.task_type, outcome });
      if (outcome.status === 'failed') this.deps.log?.error({ task: task.id, type: task.task_type, outcome }, 'task failed');
    }

    const summaries = await sendDailySummaries(this.deps, config.DAILY_SUMMARY_TIME);
    if (ran.length || summaries || recovered.requeued || recovered.closed || planned?.reminders || planned?.legal) {
      this.deps.log?.info(
        { recovered, planned, ran: ran.length, summaries },
        `scheduler: ran ${ran.length} task(s)`,
      );
    }
    return { recovered, planned, ran, summaries };
  }

  /** Run ticks until stop() is called. Errors are logged and the next tick tries again. */
  start(): void {
    const loop = async () => {
      if (this.stopping) return;
      this.running = this.tick()
        .then(() => undefined)
        .catch((err) => this.deps.log?.error({ err }, 'scheduler tick failed'));
      await this.running;
      if (!this.stopping) this.timer = setTimeout(loop, this.deps.config.SCHEDULER_POLL_SECONDS * 1000);
    };
    void loop();
  }

  /** Finish the task in progress, then stop. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
