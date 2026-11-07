import type pg from 'pg';
import type { LlmClient, LlmResponse } from '../ai/llm.js';
import type { Config } from '../config.js';
import { withTenant, type TenantContext } from '../db.js';
import type { WhatsAppSender } from '../whatsapp/client.js';
import { loadRules, localDayAndTime, withinWorkingHours } from '../whatsapp/outbound.js';
import { checkReply, FALLBACK_REPLY, parseDecision, type Decision } from './decision.js';
import { buildSystemPrompt, buildUserPrompt, type AgentContext, type AgentDebt } from './prompt.js';

export interface InboundDeps {
  pool: pg.Pool; // API role: RLS applies
  workerPool: pg.Pool; // worker role: only to find which client a phone belongs to
  config: Config;
  sender: WhatsAppSender | undefined;
  llm: LlmClient | undefined;
  now: () => Date;
}

export interface InboundMessage {
  providerMessageId: string; // WhatsApp message id (wamid)
  from: string; // +9665XXXXXXXX
  text: string;
  hasMedia: boolean;
  receivedAt: Date;
}

export type InboundResult =
  | { status: 'unknown_sender' }
  | { status: 'duplicate' }
  | {
      status: 'replied' | 'reply_failed' | 'reply_held' | 'saved';
      messageId: string;
      intent: Decision['intent'] | null;
      needsHuman: boolean;
      replyMessageId?: string;
    };

const CLOSED = ['paid', 'closed', 'written_off'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Which client and debtor a phone belongs to. Uses the worker role, because the
 * client is not known yet. If the same phone belongs to debtors of several
 * clients, the client that messaged that phone most recently wins.
 * In development, replies from WHATSAPP_DEV_REDIRECT_TO belong to whoever we
 * last messaged (the mirror of the outbound redirect).
 */
async function resolveSender(deps: InboundDeps, from: string) {
  const devReply = deps.config.NODE_ENV !== 'production' && from === deps.config.WHATSAPP_DEV_REDIRECT_TO;
  const { rows } = await deps.workerPool.query<{ client_id: string; debtor_id: string; phone_id: string }>(
    devReply
      ? `SELECT m.client_id, m.debtor_id, m.phone_id
           FROM app.messages m
          WHERE m.direction = 'outbound' AND m.channel = 'whatsapp' AND m.phone_id IS NOT NULL
          ORDER BY m.created_at DESC LIMIT 1`
      : `SELECT p.client_id, p.debtor_id, p.id AS phone_id
           FROM app.debtor_phones p
           LEFT JOIN LATERAL (
             SELECT max(m.created_at) AS last_out FROM app.messages m
              WHERE m.client_id = p.client_id AND m.phone_id = p.id AND m.direction = 'outbound'
           ) lo ON true
          WHERE p.phone_e164 = $1
          ORDER BY lo.last_out DESC NULLS LAST, p.created_at DESC
          LIMIT 1`,
    devReply ? [] : [from],
  );
  return rows[0];
}

/** Turn a "today" date plus N days into YYYY-MM-DD, as text (no time zone surprises). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Handle one message from a debtor:
 * save it, ask the AI what it means, check the AI's answer, act on it,
 * and reply (or hold the reply for staff).
 */
export async function handleInbound(deps: InboundDeps, msg: InboundMessage): Promise<InboundResult> {
  const who = await resolveSender(deps, msg.from);
  if (!who) return { status: 'unknown_sender' };
  const ctx: TenantContext = { clientId: who.client_id, actorType: 'ai' };

  // 1. Save the message and read everything the AI needs, in one transaction.
  const loaded = await withTenant(deps.pool, ctx, async (db) => {
    const saved = await db.query<{ id: string }>(
      `INSERT INTO app.messages (client_id, debtor_id, phone_id, channel, direction, body, status, provider_message_id, created_at)
       VALUES (app.current_client_id(), $1, $2, 'whatsapp', 'inbound', $3, 'received', $4, $5)
       ON CONFLICT (provider_message_id) DO NOTHING
       RETURNING id`,
      [who.debtor_id, who.phone_id, msg.text || null, msg.providerMessageId, msg.receivedAt],
    );
    const messageId = saved.rows[0]?.id;
    if (!messageId) return undefined; // Meta sent the same message twice

    const info = (
      await db.query<{ debtor_name: string; preferred_language: string; client_name: string }>(
        `SELECT dr.full_name AS debtor_name, dr.preferred_language, coalesce(c.trade_name, c.legal_name) AS client_name
           FROM app.debtors dr JOIN app.clients c ON c.id = dr.client_id WHERE dr.id = $1`,
        [who.debtor_id],
      )
    ).rows[0]!;
    const debts = (
      await db.query<AgentDebt & { id: string }>(
        `SELECT id, ref_code, reason, amount_original, amount_outstanding, status, due_date::text
           FROM app.debts WHERE debtor_id = $1 AND status <> ALL($2::text[]) ORDER BY due_date NULLS LAST, ref_code`,
        [who.debtor_id, CLOSED],
      )
    ).rows;
    const lastOutboundDebt = (
      await db.query<{ debt_id: string | null }>(
        `SELECT debt_id FROM app.messages WHERE debtor_id = $1 AND direction = 'outbound' AND debt_id IS NOT NULL
          ORDER BY created_at DESC LIMIT 1`,
        [who.debtor_id],
      )
    ).rows[0]?.debt_id;
    const recent = (
      await db.query<{ direction: 'inbound' | 'outbound'; body: string | null; at: string }>(
        `SELECT direction, body, to_char(created_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD HH24:MI') AS at
           FROM (SELECT * FROM app.messages WHERE debtor_id = $1 AND id <> $2 ORDER BY created_at DESC LIMIT 10) m
          ORDER BY created_at`,
        [who.debtor_id, messageId],
      )
    ).rows;
    const rules = await loadRules(db);
    return { messageId, info, debts, lastOutboundDebt, recent, rules };
  });
  if (!loaded) return { status: 'duplicate' };
  const { messageId, info, debts, rules } = loaded;

  const now = deps.now();
  const today = localDate(now, rules.timezone);
  const language = FALLBACK_REPLY[info.preferred_language] ? info.preferred_language : 'ar';
  const defaultDebt = debts.find((d) => d.id === loaded.lastOutboundDebt) ?? debts[0];

  // 2. Ask the AI (outside any transaction).
  let decision: Decision | undefined;
  let llmResult: LlmResponse | undefined;
  let problem: string | undefined;
  if (!deps.llm) {
    problem = 'ai_not_configured';
  } else if (debts.length === 0) {
    problem = 'no_open_debts';
  } else {
    const agentCtx: AgentContext = {
      clientName: info.client_name,
      debtorName: info.debtor_name,
      preferredLanguage: info.preferred_language,
      today,
      weekday: WEEKDAYS[localDayAndTime(now, rules.timezone).day] ?? '',
      debts,
      recentMessages: loaded.recent,
      inboundText: msg.text,
      hasMedia: msg.hasMedia,
    };
    try {
      llmResult = await deps.llm.generateJson({ system: buildSystemPrompt(agentCtx), user: buildUserPrompt(agentCtx) });
      decision = parseDecision(llmResult.text);
      if (!decision) problem = 'ai_invalid_json';
    } catch (err) {
      problem = `ai_error:${String(err).slice(0, 200)}`;
    }
  }

  // 3. Check the AI's answer. Anything doubtful falls back to a safe reply for staff to follow up.
  let debt = defaultDebt;
  if (decision?.debt_ref) debt = debts.find((d) => d.ref_code === decision!.debt_ref) ?? defaultDebt;

  let replyText = FALLBACK_REPLY[language]!;
  let needsHuman = true;
  if (decision) {
    const check = checkReply(decision.reply, {
      allowedAmounts: debts.flatMap((d) => [d.amount_outstanding, d.amount_original]),
      allowedRefs: debts.map((d) => d.ref_code),
      debtorText: msg.text,
    });
    if (check.ok) {
      replyText = decision.reply;
      needsHuman = decision.needs_human || decision.confidence < 0.5;
    } else {
      problem = `reply_rejected:${check.reason}`;
    }
    // A promise must be for today or the next 60 days.
    if (decision.promise_date && (decision.promise_date < today || decision.promise_date > addDays(today, 60))) {
      decision = { ...decision, promise_date: null };
      needsHuman = true;
    }
  }
  const intent = decision?.intent ?? null;
  if (intent && ['payment_claimed', 'dispute', 'wrong_person', 'opt_out'].includes(intent)) needsHuman = true;
  if (msg.hasMedia) needsHuman = true;

  const canSendNow =
    Boolean(deps.sender) &&
    (deps.config.NODE_ENV === 'production' || Boolean(deps.config.WHATSAPP_DEV_REDIRECT_TO)) &&
    (deps.config.AGENT_REPLY_OUTSIDE_HOURS || withinWorkingHours(now, rules));

  // 4. Record the decision and act on it.
  const acted = await withTenant(deps.pool, ctx, async (db) => {
    await db.query(
      `INSERT INTO ai.agent_runs (client_id, debtor_id, message_id, purpose, model, input_tokens, output_tokens,
                                  cost_usd, output, needs_human)
       VALUES (app.current_client_id(), $1, $2, 'reply', $3, $4, $5, $6, $7, $8)`,
      [
        who.debtor_id,
        messageId,
        llmResult?.model ?? 'none',
        llmResult?.inputTokens ?? null,
        llmResult?.outputTokens ?? null,
        llmResult?.costUsd ?? null,
        JSON.stringify({ decision: decision ?? null, problem: problem ?? null, reply: replyText, sent_now: canSendNow }),
        needsHuman,
      ],
    );

    if (debt) {
      await db.query(`UPDATE app.messages SET debt_id = $2 WHERE id = $1`, [messageId, debt.id]);
      await db.query(`UPDATE app.debts SET last_reply_at = $2 WHERE id = $1`, [debt.id, msg.receivedAt]);
    }

    if (decision && debt) {
      if (intent === 'promise_to_pay' && decision.promise_date) {
        // A promised amount above what is owed is ignored (treated as "the full amount").
        const amount =
          decision.promise_amount &&
          (await db.query<{ ok: boolean }>(`SELECT $1::numeric <= $2::numeric AS ok`, [
            decision.promise_amount,
            debt.amount_outstanding,
          ])).rows[0]?.ok
            ? decision.promise_amount
            : null;
        await db.query(
          `INSERT INTO app.promises (client_id, debt_id, promised_amount, promised_date, source_message_id)
           VALUES (app.current_client_id(), $1, $2, $3, $4)`,
          [debt.id, amount, decision.promise_date, messageId],
        );
        await db.query(
          `UPDATE app.debts SET status = 'promised' WHERE id = $1 AND status IN ('open', 'in_follow_up')`,
          [debt.id],
        );
        // Check the promise at 10:00 (client time) on the day after the grace period.
        await db.query(
          `INSERT INTO app.follow_up_tasks (client_id, debt_id, task_type, due_at)
           SELECT app.current_client_id(), $1, 'promise_check',
                  (($2::date + r.promise_grace_days) + time '10:00') AT TIME ZONE c.timezone
             FROM app.clients c LEFT JOIN app.follow_up_rules r ON r.client_id = c.id
            WHERE c.id = app.current_client_id()`,
          [debt.id, decision.promise_date],
        );
      }
      if (intent === 'dispute') {
        await db.query(
          `INSERT INTO app.disputes (client_id, debt_id, raised_message_id, reason)
           SELECT app.current_client_id(), $1, $2, $3
            WHERE NOT EXISTS (SELECT 1 FROM app.disputes WHERE debt_id = $1 AND status = 'open')`,
          [debt.id, messageId, decision.dispute_reason || msg.text.slice(0, 500) || 'Debtor disputes the amount'],
        );
      }
    }
    if (intent === 'wrong_person' || intent === 'opt_out') {
      await db.query(`UPDATE app.debtor_phones SET status = $2 WHERE id = $1`, [
        who.phone_id,
        intent === 'wrong_person' ? 'wrong_number' : 'opted_out',
      ]);
    }

    if (needsHuman || !canSendNow) {
      const kind = intent === 'payment_claimed' || msg.hasMedia ? 'payment_to_review' : intent === 'dispute' ? 'dispute' : 'reply';
      const title = !canSendNow
        ? `Reply waiting: ${info.debtor_name} wrote outside working hours`
        : intent === 'payment_claimed' || msg.hasMedia
          ? `${info.debtor_name} says they paid: check the receipt`
          : intent === 'dispute'
            ? `${info.debtor_name} disputes the amount`
            : `${info.debtor_name} needs a reply from the team`;
      await db.query(
        `INSERT INTO app.notifications (client_id, kind, title, target_table, target_id)
         VALUES (app.current_client_id(), $1, $2, 'app.messages', $3)`,
        [kind, title, messageId],
      );
    }

    if (!canSendNow) return { replyMessageId: undefined };
    const reply = await db.query<{ id: string }>(
      `INSERT INTO app.messages (client_id, debtor_id, debt_id, phone_id, channel, direction, body, ai_generated, status)
       VALUES (app.current_client_id(), $1, $2, $3, 'whatsapp', 'outbound', $4, $5, 'queued')
       RETURNING id`,
      [who.debtor_id, debt?.id ?? null, who.phone_id, replyText, Boolean(decision) && !problem],
    );
    return { replyMessageId: reply.rows[0]!.id };
  });

  if (!acted.replyMessageId) {
    return { status: 'reply_held', messageId, intent, needsHuman: true };
  }

  // 5. Send the reply (free text is allowed: the person wrote to us just now).
  const phoneNumberId = deps.config.WHATSAPP_PHONE_NUMBER_ID ?? (await senderPhoneNumberId(deps, ctx));
  const to = (deps.config.NODE_ENV !== 'production' && deps.config.WHATSAPP_DEV_REDIRECT_TO) || msg.from;
  const result = phoneNumberId
    ? await deps.sender!.sendText({ phoneNumberId, to, text: replyText })
    : ({ ok: false, errorCode: 'no_sender_number', errorMessage: 'No sender number', retryable: false } as const);

  await withTenant(deps.pool, ctx, (db) =>
    result.ok
      ? db.query(`UPDATE app.messages SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = $1`, [
          acted.replyMessageId,
          result.providerMessageId,
        ])
      : db.query(`UPDATE app.messages SET status = 'failed', error_code = $2 WHERE id = $1`, [
          acted.replyMessageId,
          result.errorCode,
        ]),
  );

  return {
    status: result.ok ? 'replied' : 'reply_failed',
    messageId,
    intent,
    needsHuman,
    replyMessageId: acted.replyMessageId,
  };
}

async function senderPhoneNumberId(deps: InboundDeps, ctx: TenantContext): Promise<string | undefined> {
  return withTenant(deps.pool, ctx, async (db) => {
    const { rows } = await db.query<{ phone_number_id: string }>(
      `SELECT sn.phone_number_id FROM app.clients c
         JOIN app.sender_numbers sn ON sn.id = c.sender_number_id AND sn.status = 'active'
        WHERE c.id = app.current_client_id()`,
    );
    return rows[0]?.phone_number_id;
  });
}
