import type { Notification } from '../api/types';
import type { I18n } from '../i18n';
import { groupDigits } from './money';

/**
 * The text of a notification in the reader's language, built from its details
 * (`data.event`, migration 0007). Older notifications without details keep the
 * title the API stored.
 */
export function notificationText(n: Notification, t: I18n['t']): string {
  const d = n.data;
  if (!d) return n.title;
  const vars = {
    name: d.name ?? '',
    ref: d.ref ?? '',
    amount: d.amount ? groupDigits(d.amount) : '',
    reminders: d.reminders ?? 0,
  };
  const event = d.event ?? legacyEvent(n);
  switch (event) {
    case 'summary': {
      const s = d.summary ?? {};
      return t('note.summary', {
        sent: s.reminders_sent ?? 0,
        replies: s.replies ?? 0,
        promises: s.promises ?? 0,
        payments: s.payments_to_review ?? 0,
      });
    }
    case 'receipt':
      return d.amount ? t('note.payment_to_review', vars) : t('note.receipt', vars);
    case 'dispute':
    case 'needs_reply':
    case 'reply_held':
    case 'legal_ready':
    case 'replied_after_last':
    case 'promise_broken':
    case 'promise_partly':
    case 'not_sent':
    case 'send_failed':
    case 'maybe_not_sent':
      return t(`note.${event}`, vars);
    default:
      return n.title;
  }
}

function legacyEvent(n: Notification): string | undefined {
  switch (n.kind) {
    case 'payment_to_review':
      return 'receipt';
    case 'reply':
      return 'needs_reply';
    case 'dispute':
    case 'promise_broken':
    case 'legal_ready':
      return n.kind;
    case 'system':
      return n.data?.summary ? 'summary' : undefined;
    default:
      return undefined;
  }
}

/** Where a notification leads: the debtor's page when it is about one debtor. */
export function notificationLink(n: Notification): string | null {
  const event = n.data?.event ?? legacyEvent(n);
  if (event === 'receipt' || event === 'dispute') return '/approvals';
  if (n.data?.debtor_id) return `/debtors/${n.data.debtor_id}`;
  if (event === 'legal_ready') return '/legal';
  return null;
}
