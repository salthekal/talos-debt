import { Check, FileImage, HandCoins, MessageSquareWarning, Send, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApprovals, useApproveReminders, useRules, useWaitingReminders } from '../api/hooks';
import type { DisputeToReview, PaymentToReview } from '../api/types';
import { Empty, ErrorState, Loading, Money, ReminderDots } from '../components/bits';
import { useI18n, type MessageKey } from '../i18n';
import { groupDigits, subtract, toHalalas } from '../lib/money';

type Tab = 'payments' | 'disputes' | 'reminders';
const TABS: Tab[] = ['payments', 'disputes', 'reminders'];
const ICON = { payments: HandCoins, disputes: MessageSquareWarning, reminders: Send } as const;

export function ApprovalsPage() {
  const { t } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const approvals = useApprovals();
  const waiting = useWaitingReminders();
  const counts: Record<Tab, number | undefined> = {
    payments: approvals.data?.payments.length,
    disputes: approvals.data?.disputes.length,
    reminders: waiting.data?.reminders.length,
  };
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : (TABS.find((x) => counts[x]) ?? 'payments');

  // Arrow keys move between tabs (the usual tab pattern).
  const onKey = (e: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const rtl = document.documentElement.dir === 'rtl';
    const next = TABS[(i + (rtl ? -step : step) + TABS.length) % TABS.length]!;
    navigate(`/approvals/${next}`);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };

  return (
    <div className="page approvals">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('approvals.title')}</h1>
          <p className="page-sub">{t('approvals.lead')}</p>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label={t('approvals.title')} onKeyDown={onKey}>
        {TABS.map((x) => {
          const Icon = ICON[x];
          return (
            <Link
              key={x}
              id={`tab-${x}`}
              to={`/approvals/${x}`}
              role="tab"
              aria-selected={tab === x}
              aria-controls={`panel-${x}`}
              tabIndex={tab === x ? 0 : -1}
              className="tab"
            >
              <Icon size={17} aria-hidden="true" />
              {t(`approvals.tab.${x}` as MessageKey)}
              {counts[x] ? <span className="tab-count">{counts[x]}</span> : null}
            </Link>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === 'reminders' ? (
          <Reminders />
        ) : approvals.isError ? (
          <ErrorState onRetry={() => approvals.refetch()} />
        ) : !approvals.data ? (
          <Loading rows={5} />
        ) : tab === 'payments' ? (
          approvals.data.payments.length ? (
            <ul className="review-list">{approvals.data.payments.map((p) => <PaymentReview key={p.id} p={p} />)}</ul>
          ) : (
            <Empty>{t('approvals.empty.payments')}</Empty>
          )
        ) : approvals.data.disputes.length ? (
          <ul className="review-list">{approvals.data.disputes.map((d) => <DisputeReview key={d.id} d={d} />)}</ul>
        ) : (
          <Empty>{t('approvals.empty.disputes')}</Empty>
        )}
      </div>
    </div>
  );
}

function PaymentReview({ p }: { p: PaymentToReview }) {
  const { t, formatDate, relative } = useI18n();
  const left = subtract(p.amount_outstanding, p.amount);
  const clears = toHalalas(left) <= 0n;
  const confidence = p.ai_match_confidence ? Math.round(Number(p.ai_match_confidence) * 100) : null;
  return (
    <li className="review panel">
      <div className="receipt" aria-hidden="true">
        <FileImage size={22} />
        <span className="receipt-bank">{p.extracted_details?.bank}</span>
        <span className="receipt-amount">{groupDigits(p.amount, { decimals: true })}</span>
        <span className="receipt-lines">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="review-body">
        <p className="review-who">
          <Link to={`/debtors/${p.debtor_id}`} className="row-title">
            {p.full_name}
          </Link>
          <span className="ref">{p.debt_ref}</span>
          <span className="muted">{relative(p.created_at)}</span>
        </p>
        <p className="review-amount">
          <Money amount={p.amount} size="lg" decimals />
        </p>
        <p className={`review-effect${clears ? ' effect-clear' : ''}`}>
          {clears ? t('approvals.payment.clears') : t('approvals.payment.leaves', { amount: groupDigits(left) })}
        </p>
        {p.extracted_details && (
          <div className="read">
            <p className="read-title">
              {t('approvals.payment.read')}
              {confidence !== null && (
                <span className={`match${confidence >= 90 ? ' match-high' : ''}`}>{t('approvals.payment.match', { pct: confidence })}</span>
              )}
            </p>
            <dl className="read-facts">
              <div>
                <dt>{t('approvals.payment.bank')}</dt>
                <dd>{p.extracted_details.bank}</dd>
              </div>
              {p.extracted_details.date && (
                <div>
                  <dt>{t('approvals.payment.date')}</dt>
                  <dd>{formatDate(p.extracted_details.date)}</dd>
                </div>
              )}
              {p.extracted_details.reference && (
                <div>
                  <dt>{t('approvals.payment.ref')}</dt>
                  <dd className="code">{p.extracted_details.reference}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </div>
      <div className="review-actions">
        <button type="button" className="btn btn-primary">
          <Check size={17} aria-hidden="true" />
          {t('approvals.approve')}
        </button>
        <button type="button" className="btn btn-quiet">
          <X size={17} aria-hidden="true" />
          {t('approvals.reject')}
        </button>
        <button type="button" className="btn btn-link">
          {t('approvals.viewReceipt')}
        </button>
      </div>
    </li>
  );
}

function DisputeReview({ d }: { d: DisputeToReview }) {
  const { t, relative } = useI18n();
  return (
    <li className="review panel review-dispute">
      <div className="review-body">
        <p className="review-who">
          <Link to={`/debtors/${d.debtor_id}`} className="row-title">
            {d.full_name}
          </Link>
          <span className="ref">{d.debt_ref}</span>
          <span className="muted">{relative(d.created_at)}</span>
        </p>
        <p className="review-amount">
          <Money amount={d.amount_outstanding} size="lg" />
        </p>
        <figure className="quote">
          <figcaption>{t('approvals.dispute.said')}</figcaption>
          <blockquote dir="auto">{d.reason}</blockquote>
        </figure>
      </div>
      <div className="review-actions">
        <button type="button" className="btn btn-quiet">{t('approvals.dispute.resolveValid')}</button>
        <button type="button" className="btn btn-primary">{t('approvals.dispute.resolveInvalid')}</button>
      </div>
    </li>
  );
}

function Reminders() {
  const { t, relative } = useI18n();
  const waiting = useWaitingReminders();
  const approve = useApproveReminders();
  const rules = useRules();
  const max = rules.data?.max_attempts ?? 5;
  const [picked, setPicked] = useState<Set<string>>(new Set());

  if (waiting.isError) return <ErrorState onRetry={() => waiting.refetch()} />;
  if (!waiting.data) return <Loading rows={5} />;
  const list = waiting.data.reminders;
  if (!list.length) return <Empty>{t('approvals.empty.reminders')}</Empty>;

  const allPicked = picked.size === list.length;
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="panel reminders">
      <p className="reminders-lead">{t('approvals.reminders.lead')}</p>
      <div className="bulk">
        <label className="check">
          <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(list.map((r) => r.task_id)))} />
          <span>{t('approvals.selectAll')}</span>
        </label>
        <div className="bulk-actions">
          {picked.size > 0 && !allPicked && (
            <button type="button" className="btn btn-primary" disabled={approve.isPending} onClick={() => approve.mutate([...picked], { onSuccess: () => setPicked(new Set()) })}>
              {t('approvals.reminders.approveSelected', { count: picked.size })}
            </button>
          )}
          <button type="button" className={`btn ${picked.size && !allPicked ? 'btn-quiet' : 'btn-primary'}`} disabled={approve.isPending} onClick={() => approve.mutate('all', { onSuccess: () => setPicked(new Set()) })}>
            <Send size={16} aria-hidden="true" className="flip-rtl" />
            {t('approvals.reminders.approveAll')}
          </button>
        </div>
      </div>
      <ul className="rem-list">
        {list.map((r) => (
          <li key={r.task_id} className={picked.has(r.task_id) ? 'rem rem-picked' : 'rem'}>
            <label className="check">
              <input type="checkbox" checked={picked.has(r.task_id)} onChange={() => toggle(r.task_id)} aria-label={t('approvals.select', { name: r.full_name })} />
            </label>
            <span className="rem-who">
              <Link to={`/debtors/${r.debtor_id}`} className="row-title">
                {r.full_name}
              </Link>
              <span className="ref">{r.ref_code}</span>
            </span>
            <Money amount={r.amount_outstanding} />
            <span className="rem-attempt">
              <ReminderDots sent={Math.min((r.attempt_number ?? 1) - 1, max)} max={max} />
              <span>{t('approvals.reminders.attempt', { n: r.attempt_number ?? 1 })}</span>
            </span>
            <span className="muted rem-due">{t('approvals.reminders.due', { when: relative(r.due_at) ?? '' })}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
