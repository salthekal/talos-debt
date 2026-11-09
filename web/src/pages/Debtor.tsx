import { ArrowLeft, Bot, Check, CheckCheck, Clock, CreditCard, Handshake, MessageSquareWarning, PauseCircle, Phone as PhoneIcon, Send, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { useDebtor, useRules } from '../api/hooks';
import type { DebtRow, Phone, TimelineEvent } from '../api/types';
import { Empty, ErrorState, Initials, Loading, Money, PaidBar, ReminderDots, StatusBadge } from '../components/bits';
import { useI18n, type MessageKey } from '../i18n';
import { share, subtract } from '../lib/money';
import { NotFound } from './NotFound';

/** Show only the last four digits of an ID number on screen. */
function maskId(id: string) {
  return `•••• ${id.slice(-4)}`;
}

function nationalityName(code: string | null, locale: string) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale.startsWith('ar') ? 'ar' : 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function DebtorPage() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const detail = useDebtor(id);
  const rules = useRules();
  const max = rules.data?.max_attempts ?? 5;

  if (detail.isError) {
    return (detail.error as Error)?.message === 'not_found' ? <NotFound /> : <div className="page"><ErrorState onRetry={() => detail.refetch()} /></div>;
  }
  if (!detail.data) {
    return (
      <div className="page">
        <Loading rows={6} />
      </div>
    );
  }
  const { debtor, phones, debts, timeline } = detail.data;
  const debtRef = new Map(debts.map((d) => [d.debt_id, d.ref_code]));

  return (
    <div className="page debtor">
      <Link to="/debtors" className="back">
        <ArrowLeft size={16} aria-hidden="true" className="flip-rtl" />
        {t('debtor.back')}
      </Link>

      <header className="debtor-head">
        <Initials name={debtor.full_name} />
        <div className="debtor-id">
          <h1 className="page-title">{debtor.full_name}</h1>
          {debtor.full_name_ar && (
            <p className="debtor-ar" lang="ar" dir="rtl">
              {debtor.full_name_ar}
            </p>
          )}
          <dl className="facts">
            <div>
              <dt>{t('debtor.id')}</dt>
              <dd className="code">{maskId(debtor.id_number)}</dd>
            </div>
            <div>
              <dt>{t('debtor.nationality')}</dt>
              <dd>{nationalityName(debtor.nationality, locale)}</dd>
            </div>
            <div>
              <dt>{t('debtor.language')}</dt>
              <dd>{t(`lang.${debtor.preferred_language}` as MessageKey)}</dd>
            </div>
          </dl>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-quiet">
            <PauseCircle size={17} aria-hidden="true" />
            {t('debtor.pause')}
          </button>
          <button type="button" className="btn btn-quiet">
            <CreditCard size={17} aria-hidden="true" />
            {t('debtor.recordPayment')}
          </button>
          <button type="button" className="btn btn-primary">
            <Send size={17} aria-hidden="true" className="flip-rtl" />
            {t('debtor.sendReminder')}
          </button>
        </div>
      </header>

      <div className="debtor-grid">
        <aside className="debtor-side">
          <section aria-labelledby="debts-title">
            <h2 id="debts-title" className="section-title">
              {t('debtor.debts')}
            </h2>
            {debts.map((d) => (
              <DebtCard key={d.debt_id} debt={d} max={max} />
            ))}
          </section>
          <section className="panel phones" aria-labelledby="phones-title">
            <h2 id="phones-title" className="section-title">
              {t('debtor.phones')}
            </h2>
            <ul>
              {phones.map((p) => (
                <PhoneRow key={p.id} phone={p} />
              ))}
            </ul>
          </section>
        </aside>

        <section className="panel journey" aria-labelledby="journey-title">
          <h2 id="journey-title" className="panel-title">
            {t('debtor.journey')}
          </h2>
          {timeline.length === 0 ? <Empty>{t('debtor.journeyEmpty')}</Empty> : <Timeline events={timeline} refs={debtRef} showRefs={debts.length > 1} />}
        </section>
      </div>
    </div>
  );
}

function DebtCard({ debt, max }: { debt: DebtRow; max: number }) {
  const { t } = useI18n();
  const paid = share(subtract(debt.amount_original, debt.amount_outstanding), debt.amount_original);
  return (
    <article className="debt-card">
      <div className="debt-card-top">
        <span className="ref">{debt.ref_code}</span>
        <StatusBadge status={debt.status} />
      </div>
      <p className="debt-card-amount">
        <Money amount={debt.amount_outstanding} size="lg" />
      </p>
      <p className="debt-card-of">
        {t('debtor.original')} <Money amount={debt.amount_original} muted />
      </p>
      <PaidBar pct={paid} />
      <dl className="debt-card-facts">
        <div>
          <dt>{t('debtors.col.reminders')}</dt>
          <dd>
            <ReminderDots sent={Math.min(debt.attempts_count, max)} max={max} />
          </dd>
        </div>
        <div>
          <dt>{t('debtors.col.document')}</dt>
          <dd className={`doc${debt.directly_enforceable ? ' doc-ok' : ''}`}>
            {debt.directly_enforceable ? <ShieldCheck size={15} aria-hidden="true" /> : <ShieldOff size={15} aria-hidden="true" />}
            {t(`instrument.${debt.instrument_type}` as MessageKey)}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function PhoneRow({ phone }: { phone: Phone }) {
  const { t } = useI18n();
  return (
    <li className={`phone-row${phone.status !== 'active' ? ' phone-off' : ''}`}>
      <PhoneIcon size={15} aria-hidden="true" />
      <bdi className="code" dir="ltr">
        {phone.phone_e164.replace(/^\+966(\d{2})(\d{3})(\d{4})$/, '+966 $1 $2 $3')}
      </bdi>
      <span className="phone-tags">
        {phone.is_primary && <span className="tag">{t('debtor.primary')}</span>}
        {phone.has_whatsapp && phone.status === 'active' && <span className="tag tag-wa">{t('debtor.whatsapp')}</span>}
        {phone.status !== 'active' && <span className="tag tag-off">{t(`debtor.phoneStatus.${phone.status}`)}</span>}
      </span>
    </li>
  );
}

const MSG_ICON: Record<string, typeof Check> = { sent: Check, delivered: CheckCheck, read: CheckCheck, failed: X, queued: Clock };

function Timeline({ events, refs, showRefs }: { events: TimelineEvent[]; refs: Map<string, string>; showRefs: boolean }) {
  const { t, formatDate, formatTime } = useI18n();
  // Group by day, oldest day at the bottom: the newest thing is what staff need first.
  const days: { day: string; items: TimelineEvent[] }[] = [];
  for (const e of events) {
    const day = formatDate(e.at, { weekday: 'long', day: 'numeric', month: 'long' });
    const last = days[days.length - 1];
    if (last?.day === day) last.items.push(e);
    else days.push({ day, items: [e] });
  }

  return (
    <ol className="timeline">
      {days.map((d) => (
        <li key={d.day} className="tl-day">
          <h3 className="tl-day-label">{d.day}</h3>
          <ol>
            {d.items.map((e) => {
              const ref = showRefs && e.debt_id ? refs.get(e.debt_id) : undefined;
              if (e.kind === 'message') {
                const out = e.data.direction === 'outbound';
                const StatusIcon = MSG_ICON[e.data.status];
                return (
                  <li key={e.id} className={`tl-item tl-msg ${out ? 'tl-out' : 'tl-in'}`}>
                    <span className="tl-node" aria-hidden="true" />
                    <div className="bubble">
                      <p className="bubble-who">
                        {out ? (e.data.ai_generated ? <><Bot size={14} aria-hidden="true" /> {t('event.ai')}</> : t('event.outbound')) : t('event.inbound')}
                        {ref && <span className="ref">{ref}</span>}
                      </p>
                      <p className="bubble-body" dir="auto">
                        {e.data.body}
                      </p>
                      <p className="bubble-meta">
                        <time dateTime={e.at}>{formatTime(e.at)}</time>
                        {out && StatusIcon && (
                          <span className={`msg-status msg-${e.data.status}`}>
                            <StatusIcon size={14} aria-hidden="true" />
                            {t(`event.msg.${e.data.status}` as MessageKey)}
                          </span>
                        )}
                      </p>
                    </div>
                  </li>
                );
              }
              return (
                <li key={e.id} className={`tl-item tl-event tl-${e.kind}`}>
                  <span className="tl-node" aria-hidden="true" />
                  <div className="event">
                    <EventLine e={e} />
                    <p className="event-meta">
                      <time dateTime={e.at}>{formatTime(e.at)}</time>
                      {ref && <span className="ref">{ref}</span>}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </li>
      ))}
    </ol>
  );
}

function EventLine({ e }: { e: Exclude<TimelineEvent, { kind: 'message' }> }) {
  const { t, formatDate } = useI18n();
  if (e.kind === 'payment') {
    return (
      <p className="event-title">
        <CreditCard size={16} aria-hidden="true" />
        {t('event.payment', { amount: e.data.amount.replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',') })}
        <span className={`pill pill-${e.data.status}`}>{t(`event.payment.${e.data.status}`)}</span>
      </p>
    );
  }
  if (e.kind === 'promise') {
    const date = formatDate(e.data.promised_date, { day: 'numeric', month: 'long' });
    return (
      <p className="event-title">
        <Handshake size={16} aria-hidden="true" />
        {e.data.promised_amount ? t('event.promiseAmount', { amount: e.data.promised_amount, date }) : t('event.promise', { date })}
        <span className={`pill pill-${e.data.status}`}>{t(`event.promise.${e.data.status}`)}</span>
      </p>
    );
  }
  return (
    <>
      <p className="event-title">
        <MessageSquareWarning size={16} aria-hidden="true" />
        {t('event.dispute')}
        <span className={`pill pill-${e.data.status}`}>{t(`event.dispute.${e.data.status}`)}</span>
      </p>
      <p className="event-quote" dir="auto">
        {e.data.reason}
      </p>
    </>
  );
}
