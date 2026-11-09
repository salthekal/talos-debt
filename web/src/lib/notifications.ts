import type { Notification } from '../api/types';
import type { I18n } from '../i18n';
import { groupDigits } from './money';

/** The text of a notification in the reader's language, built from its details. */
export function notificationText(n: Notification, t: I18n['t']): string {
  const d = n.data;
  if (!d) return n.title;
  const vars = { name: d.name ?? '', ref: d.ref ?? '', amount: d.amount ? groupDigits(d.amount) : '', reminders: d.reminders ?? 0 };
  switch (n.kind) {
    case 'payment_to_review':
    case 'reply':
    case 'dispute':
    case 'promise_broken':
    case 'legal_ready':
      return t(`note.${n.kind}`, vars);
    case 'system':
      return d.summary
        ? t('note.summary', { sent: d.summary.sent ?? 0, replies: d.summary.replies ?? 0, promises: d.summary.promises ?? 0, payments: d.summary.payments ?? 0 })
        : n.title;
  }
}
