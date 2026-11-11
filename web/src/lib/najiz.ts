import type { MessageKey } from '../i18n';

/**
 * What a Najiz request status means, in plain words (5.5). Only the statuses
 * Sal has seen are explained; any other is shown as Najiz writes it.
 */
const MEANINGS: Record<string, MessageKey> = {
  'قيد المعالجة': 'najizStatus.processing',
  'قيد التنفيذ': 'najizStatus.executing',
};

export function najizMeaning(status: string | null | undefined): MessageKey | null {
  return status ? (MEANINGS[status.trim()] ?? null) : null;
}
