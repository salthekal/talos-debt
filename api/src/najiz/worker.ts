/**
 * The Najiz worker (5.4): takes a run the client started from the dashboard,
 * signs in to Najiz with the owner's Nafath approval, and files each approved
 * note, writing its progress so the dashboard can follow it.
 *
 * Only finding and claiming runs uses the worker connection. Everything else
 * runs inside withTenant with actor 'system' and the person who started the
 * run, so RLS and the audit log apply (Najiz rule 5).
 *
 * Najiz rules (CLAUDE.md): the session is only in the robot's memory and is
 * closed when the run ends; nothing about it is logged; anything unexpected
 * stops the run and tells staff.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type pg from 'pg';
import { withTenant, type Db, type TenantContext } from '../db.js';
import { insertDocumentRow, storeFile, type DocType } from '../storage/documents.js';
import type { FileStorage } from '../storage/storage.js';
import { loadDetail, missingOf, loadRows } from '../legal/case.js';
import { NAJIZ_MAX_BYTES, PDF } from '../legal/readiness.js';
import { claimRun, heartbeat, isFinished, recoverLostRuns, stopRun, type ClaimedRun } from './runs.js';
import { NajizStop, saudiMobile, type FileToUpload, type NajizFiling, type NajizSite } from './site.js';

export interface NajizWorkerDeps {
  pool: pg.Pool;
  workerPool: pg.Pool;
  storage: FileStorage;
  /** A new Najiz session for each run. */
  site: () => NajizSite;
  /** How long the owner has to choose the number in Nafath. */
  nafathSeconds: number;
  /** A run whose worker has not written for this long is stopped. */
  staleMinutes: number;
  /** How often to look again while waiting for Nafath. */
  pollMs: number;
  now: () => Date;
  log: { info(o: object, msg: string): void; error(o: object, msg: string): void };
  workerId?: string;
}

interface Item {
  id: string;
  legal_case_id: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NajizWorker {
  readonly id: string;
  private stopping = false;
  private loop: Promise<void> | null = null;

  constructor(private readonly deps: NajizWorkerDeps) {
    this.id = deps.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  /** One round: recover lost runs, then take and finish at most one run. */
  async tick(): Promise<{ recovered: number; ran: string | null }> {
    const recovered = await recoverLostRuns(this.deps.workerPool, this.deps.staleMinutes);
    const run = await claimRun(this.deps.workerPool, this.id);
    if (run) await this.process(run);
    return { recovered, ran: run?.id ?? null };
  }

  start(everyMs: number) {
    this.loop = (async () => {
      while (!this.stopping) {
        try {
          const r = await this.tick();
          if (r.ran) continue; // there may be another one waiting
        } catch (err) {
          this.deps.log.error({ err: (err as Error).name }, 'najiz: round failed');
        }
        await sleep(everyMs);
      }
    })();
  }

  async stop() {
    this.stopping = true;
    await this.loop;
  }

  private tenant<T>(run: ClaimedRun, fn: (db: Db) => Promise<T>) {
    const ctx: TenantContext = { clientId: run.client_id, userId: run.requested_by, actorType: 'system' };
    return withTenant(this.deps.pool, ctx, fn);
  }

  async process(run: ClaimedRun) {
    const { log } = this.deps;
    const site = this.deps.site();
    const beat = setInterval(() => void heartbeat(this.deps.workerPool, run.id).catch(() => undefined), 15_000);
    let current: Item | null = null;
    log.info({ run: run.id, client: run.client_id, kind: run.kind }, 'najiz: run started');
    try {
      const login = await this.tenant(run, async (db) =>
        (await db.query(`SELECT owner_id_number, unified_number FROM app.clients WHERE id = app.current_client_id()`)).rows[0],
      );
      if (!login?.owner_id_number || !login?.unified_number) {
        throw new NajizStop('details_differ', 'The owner ID number or the unified number is missing');
      }
      if (await this.tenant(run, (db) => isFinished(db, run.id))) return;

      // A. Sign in: Najiz shows a number, the owner chooses it in Nafath.
      const { nafathNumber } = await site.startSignIn(login.owner_id_number);
      const expires = new Date(this.deps.now().getTime() + this.deps.nafathSeconds * 1000);
      const shown = await this.tenant(run, async (db) =>
        (await db.query(
          `UPDATE app.najiz_runs SET stage = 'waiting_nafath', nafath_number = $2, nafath_expires_at = $3, heartbeat_at = now()
            WHERE id = $1 AND stage = 'starting'`,
          [run.id, nafathNumber, expires],
        )).rowCount,
      );
      if (!shown) return; // stopped by staff meanwhile
      for (;;) {
        if (await site.signedIn()) break;
        if (await this.tenant(run, (db) => isFinished(db, run.id))) return;
        if (this.deps.now() >= expires) {
          await this.tenant(run, (db) =>
            db.query(
              `UPDATE app.najiz_runs SET stage = 'expired', nafath_number = NULL, finished_at = now()
                WHERE id = $1 AND stage = 'waiting_nafath'`,
              [run.id],
            ),
          );
          log.info({ run: run.id }, 'najiz: Nafath not approved in time');
          return;
        }
        await sleep(this.deps.pollMs);
      }
      const working = await this.tenant(run, async (db) =>
        (await db.query(
          `UPDATE app.najiz_runs SET stage = 'working', nafath_number = NULL, heartbeat_at = now()
            WHERE id = $1 AND stage = 'waiting_nafath'`,
          [run.id],
        )).rowCount,
      );
      if (!working) return;
      await site.chooseCompany(login.unified_number);

      if (run.kind === 'status_check') {
        const checked = await this.checkAll(run, site, (item) => (current = item));
        current = null;
        await this.tenant(run, (db) =>
          db.query(`UPDATE app.najiz_runs SET stage = 'done', finished_at = now() WHERE id = $1 AND stage = 'working'`, [run.id]),
        );
        log.info({ run: run.id, requests: checked }, 'najiz: status check finished');
        return;
      }

      // B. One request per note, in the order the client chose them.
      const items = await this.tenant(run, async (db) =>
        (await db.query<Item>(
          `SELECT id, legal_case_id FROM app.najiz_run_items WHERE run_id = $1 AND step = 'waiting' ORDER BY position`,
          [run.id],
        )).rows,
      );
      for (const item of items) {
        if (await this.tenant(run, (db) => isFinished(db, run.id))) return;
        const prepared = await this.tenant(run, (db) => loadFiling(db, item.legal_case_id));
        if ('problem' in prepared) {
          await this.tenant(run, (db) => setItem(db, item.id, { step: 'stopped', error: prepared.problem }));
          continue;
        }
        const filing = await withFiles(prepared, this.deps.storage);
        current = item;
        const filed = await site.fileNote(filing, {
          onStep: (step) => this.tenant(run, (db) => setItem(db, item.id, { step })),
          mayStillSend: async () => !(await this.tenant(run, (db) => isFinished(db, run.id))),
        });
        await this.recordFiled(run, item, prepared, filed);
        current = null;
      }
      await this.tenant(run, (db) =>
        db.query(`UPDATE app.najiz_runs SET stage = 'done', finished_at = now() WHERE id = $1 AND stage = 'working'`, [run.id]),
      );
      log.info({ run: run.id, notes: items.length }, 'najiz: run finished');
    } catch (err) {
      const stop = err instanceof NajizStop ? err : new NajizStop('unexpected_page', 'The robot stopped on an unexpected problem');
      // Plain words only: never the error's own message, which could hold page content.
      log.error({ run: run.id, reason: stop.reason, detail: stop.detail, err: (err as Error).name }, 'najiz: run stopped');
      await this.tenant(run, async (db) => {
        if (current) {
          await setItem(db, current.id, {
            // "send" may have been pressed: keep 'sending', so the note is not filed again before staff check Najiz.
            step: stop.afterSend ? 'sending' : 'stopped',
            error: stop.afterSend ? `${stop.detail}. Check on Najiz whether this request was sent.` : stop.detail,
          });
        }
        const stopped = await stopRun(db, run.id, stop.reason, stop.detail);
        if (stopped && stop.reason !== 'cancelled') {
          await db.query(
            `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data)
             VALUES (app.current_client_id(), 'system', $1, 'app.najiz_runs', $2, $3)`,
            [
              run.kind === 'file' ? 'Filing on Najiz stopped. Check the Legal page.' : 'The Najiz status check stopped.',
              run.id,
              JSON.stringify({ event: 'najiz_stopped', kind: run.kind, reason: stop.reason, maybe_sent: stop.afterSend && current ? 1 : 0 }),
            ],
          );
        }
      }).catch((e2) => log.error({ run: run.id, err: (e2 as Error).name }, 'najiz: could not save the stop'));
    } finally {
      clearInterval(beat);
      await site.close();
    }
  }

  /**
   * C. Read the status of each request (5.5). A status that changed is saved
   * on the case with a history row, and the client is told.
   */
  private async checkAll(run: ClaimedRun, site: NajizSite, onItem: (i: Item) => void): Promise<number> {
    const items = await this.tenant(run, async (db) =>
      (await db.query<Item & { request_number: string }>(
        `SELECT id, legal_case_id, request_number FROM app.najiz_run_items WHERE run_id = $1 AND step = 'waiting' ORDER BY position`,
        [run.id],
      )).rows,
    );
    for (const item of items) {
      if (await this.tenant(run, (db) => isFinished(db, run.id))) return items.length;
      onItem(item);
      const read = await site.checkStatus(item.request_number);
      await this.tenant(run, async (db) => {
        const before = (await db.query(
          `SELECT l.status, l.najiz_status, l.debt_id, d.ref_code, dr.full_name, d.debtor_id
             FROM app.legal_cases l JOIN app.debts d ON d.id = l.debt_id JOIN app.debtors dr ON dr.id = d.debtor_id
            WHERE l.id = $1`,
          [item.legal_case_id],
        )).rows[0];
        await db.query(
          `UPDATE app.legal_cases SET najiz_status = $2, najiz_circuit = coalesce($3, najiz_circuit),
                  najiz_status_checked_at = now(), updated_at = now()
            WHERE id = $1`,
          [item.legal_case_id, read.status, read.circuit],
        );
        await db.query(`UPDATE app.najiz_run_items SET step = 'checked', najiz_status = $2, updated_at = now() WHERE id = $1`, [item.id, read.status]);
        if (before && before.najiz_status !== read.status) {
          await db.query(
            `INSERT INTO app.legal_case_events (client_id, legal_case_id, status, najiz_status, source)
             VALUES (app.current_client_id(), $1, $2, $3, 'najiz_check')`,
            [item.legal_case_id, before.status, read.status],
          );
          await db.query(
            `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data)
             VALUES (app.current_client_id(), 'system', $1, 'app.debts', $2, $3)`,
            [
              `Najiz request ${item.request_number}: ${read.status}`,
              before.debt_id,
              JSON.stringify({ event: 'najiz_status', name: before.full_name, ref: before.ref_code, number: item.request_number,
                status: read.status, debtor_id: before.debtor_id }),
            ],
          );
        }
      });
    }
    return items.length;
  }

  /**
   * Najiz accepted the request: save its number and the confirmation picture,
   * mark the case submitted and the debt in legal, all in one transaction.
   */
  private async recordFiled(run: ClaimedRun, item: Item, f: PreparedFiling, filed: { requestNumber: string; receipt: Buffer }) {
    const doc = {
      clientId: run.client_id,
      // Allowed by the database since migration 0008; the upload list does not offer it to people.
      docType: 'najiz_receipt' as DocType,
      fileName: `najiz-${filed.requestNumber}.png`,
      mimeType: 'image/png',
      bytes: filed.receipt,
      debtorId: f.debtorId,
      debtId: f.debtId,
      source: 'system_generated' as const,
    };
    let stored: Awaited<ReturnType<typeof storeFile>> | null = null;
    try {
      stored = await storeFile(this.deps.storage, doc);
    } catch {
      stored = null; // the request is filed; the picture is only a copy
    }
    try {
      await this.tenant(run, async (db) => {
        const updated = await db.query(
          `UPDATE app.legal_cases
              SET status = 'submitted', najiz_request_number = $2, submitted_at = now(), submitted_by_name = $3,
                  updated_at = now()
            WHERE id = $1 AND status = 'approved'`,
          [f.caseId, filed.requestNumber, f.ownerName],
        );
        if (!updated.rowCount) throw new Error('case changed');
        await db.query(
          `INSERT INTO app.legal_case_events (client_id, legal_case_id, status, note, source)
           VALUES (app.current_client_id(), $1, 'submitted', $2, 'najiz_filing')`,
          [f.caseId, `Filed on Najiz by Talos, request ${filed.requestNumber}`],
        );
        await db.query(`UPDATE app.debts SET status = 'in_legal' WHERE id = $1 AND status = 'legal_ready'`, [f.debtId]);
        if (stored) await insertDocumentRow(db, doc, stored);
        await setItem(db, item.id, { step: 'sent', request_number: filed.requestNumber, error: null });
        await db.query(
          `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id, data)
           VALUES (app.current_client_id(), 'system', $1, 'app.debts', $2, $3)`,
          [
            `Filed on Najiz: request ${filed.requestNumber}`,
            f.debtId,
            JSON.stringify({ event: 'najiz_filed', name: f.debtorName, ref: f.refCode, number: filed.requestNumber, debtor_id: f.debtorId }),
          ],
        );
      });
    } catch (err) {
      if (stored) await this.deps.storage.remove(stored.storageKey).catch(() => undefined);
      // Najiz has the request: keep its number on the note so staff can add it by hand.
      await this.tenant(run, (db) =>
        setItem(db, item.id, {
          step: 'sending',
          request_number: filed.requestNumber,
          error: `Filed on Najiz as request ${filed.requestNumber}, but Talos could not save it. Add the number to the case by hand.`,
        }),
      ).catch(() => undefined);
      throw new NajizStop('unexpected_page', 'A filed request could not be saved in Talos', true);
    }
  }
}

async function setItem(db: Db, id: string, v: { step?: string; request_number?: string; error?: string | null }) {
  await db.query(
    `UPDATE app.najiz_run_items
        SET step = coalesce($2, step), request_number = coalesce($3, request_number),
            error = CASE WHEN $4::boolean THEN $5 ELSE error END, updated_at = now()
      WHERE id = $1`,
    [id, v.step ?? null, v.request_number ?? null, 'error' in v, v.error ?? null],
  );
}

interface StoredRef {
  name: string;
  mimeType: string;
  key: string;
  size: number;
}

export interface PreparedFiling extends Omit<NajizFiling, 'crFile' | 'contractFile' | 'partnersFile' | 'note'> {
  caseId: string;
  debtId: string;
  debtorId: string;
  debtorName: string;
  refCode: string;
  ownerName: string;
  files: { cr: StoredRef; contract: StoredRef | null; partners: StoredRef | null; note: StoredRef };
  note: Omit<NajizFiling['note'], 'file'>;
}

/**
 * Everything one request needs, read again just before filing, inside the
 * transaction. The case must still be approved with nothing missing.
 */
export async function loadFiling(db: Db, legalCaseId: string): Promise<PreparedFiling | { problem: string }> {
  const c = (await db.query(
    `SELECT id, debt_id, status, najiz_request_number, contact_email, contact_phone FROM app.legal_cases WHERE id = $1`,
    [legalCaseId],
  )).rows[0];
  if (!c || c.status !== 'approved' || c.najiz_request_number) return { problem: 'This case is no longer waiting to be filed' };
  const [row] = await loadRows(db, c.debt_id);
  if (!row || missingOf(row).length) return { problem: 'Najiz needs details that are missing on this case' };
  const d = await loadDetail(db, c.debt_id);
  if (!d) return { problem: 'This case is no longer waiting to be filed' };
  const keys = (await db.query(
    `SELECT id, storage_key, mime_type, size_bytes::int AS size FROM app.documents WHERE id = ANY($1)`,
    [[d.files.cr?.id, d.files.establishment_contract?.id, d.files.partners_decision?.id, d.files.promissory_note?.id].filter(Boolean)],
  )).rows;
  const ref = (doc: { id: string; file_name: string } | null): StoredRef | null => {
    const k = doc && keys.find((x) => x.id === doc.id);
    // Najiz takes PDFs of at most 0.95 MB. The readiness check already holds this for the required files.
    if (!doc || !k || k.mime_type !== PDF || k.size > NAJIZ_MAX_BYTES) return null;
    return { name: doc.file_name, mimeType: PDF, key: k.storage_key, size: k.size };
  };
  const cr = ref(d.files.cr);
  const note = ref(d.files.promissory_note);
  if (!cr || !note) return { problem: 'Najiz needs details that are missing on this case' };
  const owner = (await db.query(`SELECT owner_name FROM app.clients WHERE id = app.current_client_id()`)).rows[0];
  const n = d.note;
  return {
    caseId: c.id,
    debtId: c.debt_id,
    debtorId: d.row.debtor_id,
    debtorName: d.debtor.full_name,
    refCode: d.row.ref_code,
    ownerName: owner.owner_name,
    unifiedNumber: d.company.unified_number!,
    contactEmail: c.contact_email,
    contactPhone: saudiMobile(c.contact_phone),
    bankName: d.company.bank_name!,
    iban: d.company.iban!.replace(/\s/g, ''),
    debtor: {
      nationality: d.debtor.nationality!,
      idType: d.debtor.id_type as 'national_id' | 'iqama' | 'passport',
      idNumber: d.debtor.id_number!,
      firstName: d.debtor.first_name!,
      fatherName: d.debtor.father_name,
      grandfatherName: d.debtor.grandfather_name,
      familyName: d.debtor.family_name!,
      phone: d.debtor.phone?.startsWith('+9665') ? saudiMobile(d.debtor.phone) : null,
    },
    note: {
      faceAmount: n.face_amount ?? d.amounts.claimed,
      received: d.amounts.received,
      claimed: d.amounts.claimed,
      referenceNumber: n.reference_number,
      issueDate: n.issue_date!,
      issueCountry: n.issue_country ?? 'SA',
      issueCity: n.issue_city!,
      dueOnDemand: n.due_on_demand,
      dueDate: n.due_date,
    },
    files: { cr, contract: ref(d.files.establishment_contract), partners: ref(d.files.partners_decision), note },
  };
}

/** Read the files from storage, outside any transaction. */
async function withFiles(p: PreparedFiling, storage: FileStorage): Promise<NajizFiling> {
  const read = async (r: StoredRef | null): Promise<FileToUpload | null> =>
    r ? { name: r.name.toLowerCase().endsWith('.pdf') ? r.name : `${r.name}.pdf`, mimeType: r.mimeType, bytes: await storage.get(r.key) } : null;
  const [crFile, contractFile, partnersFile, noteFile] = await Promise.all([
    read(p.files.cr), read(p.files.contract), read(p.files.partners), read(p.files.note),
  ]);
  return {
    unifiedNumber: p.unifiedNumber, contactEmail: p.contactEmail, contactPhone: p.contactPhone, bankName: p.bankName, iban: p.iban,
    crFile: crFile!, contractFile, partnersFile, debtor: p.debtor, note: { ...p.note, file: noteFile! },
  };
}
