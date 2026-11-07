import type pg from 'pg';
import type { Config } from '../config.js';
import { withTenant, type TenantContext } from '../db.js';
import { renderTemplate, type WhatsAppSender } from './client.js';

export type ReminderPurpose = 'first_reminder' | 'follow_up' | 'final_notice';

/** Why a reminder was not sent. Shown to staff, so kept short and clear. */
export class SendBlocked extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'debt_not_active'
      | 'debtor_not_contactable'
      | 'no_active_phone'
      | 'outside_working_hours'
      | 'no_template'
      | 'not_configured',
    message: string,
  ) {
    super(message);
  }
}

// Debt statuses that must never receive reminders.
const STOPPED = new Set(['paid', 'disputed', 'paused', 'legal_ready', 'in_legal', 'written_off', 'closed']);

// Our language codes to Meta template language codes.
const META_LANG: Record<string, string> = { ar: 'ar', en: 'en', ur: 'ur', bn: 'bn', hi: 'hi' };

export interface OutboundDeps {
  pool: pg.Pool;
  config: Config;
  sender: WhatsAppSender | undefined;
  now: () => Date;
}

interface DebtRow {
  debt_id: string;
  debt_ref: string;
  amount_outstanding: string;
  debt_status: string;
  debtor_id: string;
  debtor_name: string;
  debtor_status: string;
  preferred_language: string;
  client_name: string;
  sender_number_id: string | null;
  sender_phone_number_id: string | null;
}

interface RulesRow {
  working_hours_start: string;
  working_hours_end: string;
  working_days: number[];
  timezone: string;
}

/** Day of week (0 = Sunday) and "HH:MM" in the client's time zone. */
export function localDayAndTime(now: Date, timeZone: string): { day: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, time: `${get('hour')}:${get('minute')}` };
}

export function withinWorkingHours(now: Date, rules: RulesRow): boolean {
  const { day, time } = localDayAndTime(now, rules.timezone);
  const start = rules.working_hours_start.slice(0, 5);
  const end = rules.working_hours_end.slice(0, 5);
  return rules.working_days.includes(day) && time >= start && time < end;
}

/**
 * Send one reminder template for a debt, as a staff member or the system.
 *
 * Order matters: checks and the "queued" message are saved in one transaction,
 * then Meta is called outside any transaction, then the result is saved.
 * So a slow Meta call never holds the database, and a crash leaves a visible
 * "queued" message instead of a silent send.
 */
export async function sendReminder(
  deps: OutboundDeps,
  ctx: TenantContext,
  debtId: string,
  purpose: ReminderPurpose,
) {
  const { config } = deps;
  if (!deps.sender) {
    throw new SendBlocked('not_configured', 'WhatsApp is not configured (WHATSAPP_TOKEN is missing)');
  }
  if (config.NODE_ENV !== 'production' && !config.WHATSAPP_DEV_REDIRECT_TO) {
    throw new SendBlocked(
      'not_configured',
      'Outside production, set WHATSAPP_DEV_REDIRECT_TO so messages go to your own number, not to debtors',
    );
  }

  const prepared = await withTenant(deps.pool, ctx, async (db) => {
    const debt = (
      await db.query<DebtRow>(
        `SELECT d.id AS debt_id, d.ref_code AS debt_ref, d.amount_outstanding, d.status AS debt_status,
                dr.id AS debtor_id, dr.full_name AS debtor_name, dr.status AS debtor_status,
                dr.preferred_language, coalesce(c.trade_name, c.legal_name) AS client_name,
                c.sender_number_id, sn.phone_number_id AS sender_phone_number_id
           FROM app.debts d
           JOIN app.debtors dr ON dr.id = d.debtor_id
           JOIN app.clients c ON c.id = d.client_id
           LEFT JOIN app.sender_numbers sn ON sn.id = c.sender_number_id AND sn.status = 'active'
          WHERE d.id = $1`,
        [debtId],
      )
    ).rows[0];
    if (!debt) throw new SendBlocked('not_found', 'Debt not found');
    if (STOPPED.has(debt.debt_status) || debt.amount_outstanding === '0.00') {
      throw new SendBlocked('debt_not_active', `Reminders are stopped for this debt (status: ${debt.debt_status})`);
    }
    if (debt.debtor_status !== 'active') {
      throw new SendBlocked('debtor_not_contactable', `Debtor cannot be contacted (status: ${debt.debtor_status})`);
    }

    const rules = (
      await db.query<RulesRow>(
        `SELECT r.working_hours_start::text, r.working_hours_end::text, r.working_days, c.timezone
           FROM app.follow_up_rules r JOIN app.clients c ON c.id = r.client_id`,
      )
    ).rows[0] ?? {
      working_hours_start: '09:00',
      working_hours_end: '20:00',
      working_days: [0, 1, 2, 3, 4],
      timezone: 'Asia/Riyadh',
    };
    if (!withinWorkingHours(deps.now(), rules)) {
      throw new SendBlocked(
        'outside_working_hours',
        `Outside working hours (${rules.working_hours_start.slice(0, 5)} to ${rules.working_hours_end.slice(0, 5)}, ${rules.timezone})`,
      );
    }

    const phone = (
      await db.query<{ id: string; phone_e164: string }>(
        `SELECT id, phone_e164 FROM app.debtor_phones
          WHERE debtor_id = $1 AND status = 'active' AND has_whatsapp IS NOT FALSE
          ORDER BY is_primary DESC, created_at LIMIT 1`,
        [debt.debtor_id],
      )
    ).rows[0];
    if (!phone) throw new SendBlocked('no_active_phone', 'Debtor has no active WhatsApp number');

    // Client's own template first, then the Talos default; debtor's language, then Arabic, then English.
    const template = (
      await db.query<{ id: string; meta_template_name: string; language: string; body: string; variables: string[] }>(
        `SELECT id, meta_template_name, language, body, variables
           FROM app.message_templates
          WHERE purpose = $1 AND language = ANY($2::text[])
            AND (approval_status = 'approved' OR $3)
          ORDER BY (client_id IS NULL), array_position($2::text[], language)
          LIMIT 1`,
        [purpose, [debt.preferred_language, 'ar', 'en'], Boolean(config.WHATSAPP_DEV_TEMPLATE)],
      )
    ).rows[0];
    if (!template) throw new SendBlocked('no_template', `No approved "${purpose}" template`);

    const values: Record<string, string> = {
      debtor_name: debt.debtor_name,
      client_name: debt.client_name,
      amount: debt.amount_outstanding,
      debt_ref: debt.debt_ref,
    };
    const params = template.variables.map((v) => values[v] ?? '');
    const body = renderTemplate(template.body, params);

    const message = (
      await db.query<{ id: string }>(
        `INSERT INTO app.messages (client_id, debtor_id, debt_id, phone_id, sender_number_id, channel,
                                   direction, template_id, body, ai_generated, sent_by, status)
         VALUES (app.current_client_id(), $1, $2, $3, $4, 'whatsapp', 'outbound', $5, $6, false,
                 nullif($7, '')::uuid, 'queued')
         RETURNING id`,
        [debt.debtor_id, debt.debt_id, phone.id, debt.sender_number_id, template.id, body, ctx.userId ?? ''],
      )
    ).rows[0]!;

    return { debt, phone, template, params, body, messageId: message.id };
  });

  const phoneNumberId = config.WHATSAPP_PHONE_NUMBER_ID ?? prepared.debt.sender_phone_number_id;
  if (!phoneNumberId) {
    await markFailed(deps, ctx, prepared.messageId, 'no_sender_number');
    throw new SendBlocked('not_configured', 'This client has no active WhatsApp sender number');
  }

  // Development overrides: own phone and Meta's test template.
  const to = config.WHATSAPP_DEV_REDIRECT_TO ?? prepared.phone.phone_e164;
  const [devName, devLang] = config.WHATSAPP_DEV_TEMPLATE?.split(':') ?? [];
  const result = await deps.sender.sendTemplate({
    phoneNumberId,
    to,
    templateName: devName ?? prepared.template.meta_template_name,
    languageCode: devLang ?? META_LANG[prepared.template.language] ?? 'en',
    bodyParams: devName ? [] : prepared.params,
  });

  if (!result.ok) {
    await markFailed(deps, ctx, prepared.messageId, result.errorCode);
    return {
      messageId: prepared.messageId,
      status: 'failed' as const,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      retryable: result.retryable,
    };
  }

  await withTenant(deps.pool, ctx, async (db) => {
    await db.query(
      `UPDATE app.messages SET status = 'sent', provider_message_id = $2, sent_at = now() WHERE id = $1`,
      [prepared.messageId, result.providerMessageId],
    );
    await db.query(
      `UPDATE app.debts
          SET attempts_count = attempts_count + 1,
              last_contact_at = now(),
              status = CASE WHEN status = 'open' THEN 'in_follow_up' ELSE status END
        WHERE id = $1`,
      [prepared.debt.debt_id],
    );
  });

  return {
    messageId: prepared.messageId,
    status: 'sent' as const,
    providerMessageId: result.providerMessageId,
    to,
    redirected: to !== prepared.phone.phone_e164,
    body: prepared.body,
  };
}

async function markFailed(deps: OutboundDeps, ctx: TenantContext, messageId: string, errorCode: string) {
  await withTenant(deps.pool, ctx, (db) =>
    db.query(`UPDATE app.messages SET status = 'failed', error_code = $2 WHERE id = $1`, [messageId, errorCode]),
  );
}
