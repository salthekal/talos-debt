import { AlertTriangle, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { DebtStatus } from '../api/types';
import { useI18n } from '../i18n';
import { groupDigits } from '../lib/money';

/** An amount in SAR. Figures line up in columns (tabular digits). */
export function Money({ amount, decimals, size, muted }: { amount: string; decimals?: boolean; size?: 'lg' | 'xl'; muted?: boolean }) {
  const { t } = useI18n();
  return (
    <span className={`money${size ? ` money-${size}` : ''}${muted ? ' money-muted' : ''}`}>
      <span className="money-unit">{t('money.sar')}</span>
      <bdi className="money-value">{groupDigits(amount, { decimals })}</bdi>
    </span>
  );
}

const TONE: Record<DebtStatus, 'neutral' | 'active' | 'amber' | 'green' | 'red' | 'legal' | 'muted'> = {
  open: 'neutral',
  in_follow_up: 'active',
  promised: 'amber',
  partly_paid: 'green',
  paid: 'green',
  disputed: 'red',
  paused: 'muted',
  legal_ready: 'legal',
  in_legal: 'legal',
  written_off: 'muted',
  closed: 'muted',
};

export function StatusBadge({ status }: { status: DebtStatus }) {
  const { t } = useI18n();
  return (
    <span className={`badge badge-${TONE[status]}`}>
      <span className="badge-dot" aria-hidden="true" />
      {t(`status.${status}`)}
    </span>
  );
}

/**
 * Reminders sent out of the maximum, as the dots of the Talos mark:
 * filled for sent, hollow for still to come. ●●●○○ = 3 of 5.
 */
export function ReminderDots({ sent, max }: { sent: number; max: number }) {
  const { t } = useI18n();
  const label = t('debtors.remindersSent', { sent, max });
  return (
    <span className="dots" role="img" aria-label={label} title={label}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < sent ? 'dot dot-on' : 'dot'} />
      ))}
    </span>
  );
}

/** A thin bar for how much of a debt is paid. */
export function PaidBar({ pct }: { pct: string | null }) {
  const v = pct === null ? 0 : Math.min(100, Number(pct));
  return (
    <span className="paidbar" aria-hidden="true">
      <span className="paidbar-fill" style={{ inlineSize: `${v}%` }} />
    </span>
  );
}

export function Initials({ name }: { name: string }) {
  const letters = name
    .split(/\s+/)
    .filter((w) => w && !/^(al|el)-?$/i.test(w))
    .map((w) => w.replace(/^(al|el)-/i, '')[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span className="initials" aria-hidden="true">
      {letters}
    </span>
  );
}

export function Loading({ label, rows = 4 }: { label?: string; rows?: number }) {
  const { t } = useI18n();
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="visually-hidden">{label ?? t('common.loading')}</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" style={{ inlineSize: `${92 - i * 11}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div className="state state-error" role="alert">
      <AlertTriangle size={20} aria-hidden="true" />
      <p>{t('common.error')}</p>
      {onRetry && (
        <button type="button" className="btn btn-quiet" onClick={onRetry}>
          <RotateCw size={16} aria-hidden="true" />
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <p>{children}</p>
      {action}
    </div>
  );
}
