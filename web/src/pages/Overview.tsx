import { ArrowUpRight, Bell, Gavel, HandCoins, MessageSquareWarning, Send, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApprovals, useMe, useNotifications, useSummary, useTotals, useWaitingReminders } from '../api/hooks';
import type { DebtStatus, Summary } from '../api/types';
import { ErrorState, Loading, Money, StatusBadge } from '../components/bits';
import { RecoveryRing } from '../components/RecoveryRing';
import { TIME_ZONE, useI18n } from '../i18n';
import { share, sum } from '../lib/money';
import { notificationLink, notificationText } from '../lib/notifications';

/** Statuses that still have money in play, in the order a debt moves through them. */
const PIPELINE: DebtStatus[] = ['open', 'in_follow_up', 'promised', 'partly_paid', 'disputed', 'paused', 'legal_ready', 'in_legal'];

function greetingKey(now: Date) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: TIME_ZONE }).format(now));
  return hour < 12 ? 'greeting.morning' : hour < 17 ? 'greeting.afternoon' : 'greeting.evening';
}

export function OverviewPage() {
  const { t, formatDate } = useI18n();
  const me = useMe();
  const totals = useTotals();
  const summary = useSummary();
  const first = me.data?.user.fullName.split(' ')[0] ?? '';

  return (
    <div className="page overview">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t(greetingKey(new Date()), { name: first })}</h1>
          <p className="page-sub">
            {me.data?.client?.trade_name ?? me.data?.client?.legal_name}
            <span className="sep" aria-hidden="true" />
            {formatDate(new Date(), { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </header>

      {totals.isError ? (
        <ErrorState onRetry={() => totals.refetch()} />
      ) : !totals.data || !summary.data ? (
        <section className="hero hero-loading">
          <Loading rows={3} />
        </section>
      ) : (
        <Hero totals={totals.data} summary={summary.data} />
      )}

      <div className="overview-grid">
        <Today summary={summary.data} />
        <Pipeline summary={summary.data} />
      </div>

      {totals.data && <Enforceability pct={totals.data.enforceable_share_pct} paper={Number(totals.data.paper_notes_at_risk)} />}

      <Activity />
    </div>
  );
}

function Hero({ totals, summary }: { totals: NonNullable<ReturnType<typeof useTotals>['data']>; summary: Summary }) {
  const { t } = useI18n();
  const reminders = summary.reminders_sent;
  const promises = summary.promises_open;
  const legal = summary.legal;
  const pct = share(totals.recovered, totals.total_owed);

  return (
    <section className="hero" aria-labelledby="hero-title">
      <RecoveryRing
        pct={pct}
        size={300}
        stages={[
          { label: t('overview.stage.reminders'), value: String(reminders) },
          { label: t('overview.stage.promises'), value: String(promises) },
          { label: t('overview.stage.legal'), value: String(legal) },
        ]}
      />
      <div className="hero-figures">
        <h2 id="hero-title" className="hero-label">
          {t('overview.recovered')}
        </h2>
        <p className="hero-amount">
          <Money amount={totals.recovered} size="xl" />
        </p>
        <p className="hero-of">{t('overview.recoveredOf', { total: groupTotal(totals.total_owed) })}</p>
        <dl className="hero-split">
          <Figure label={t('overview.open')} amount={totals.open_balance} />
          <Figure label={t('overview.promised')} amount={totals.promised} tone="amber" />
          <Figure label={t('overview.disputed')} amount={totals.disputed} tone="red" />
          <Figure label={t('overview.inLegal')} amount={totals.in_legal} tone="legal" />
        </dl>
      </div>
    </section>
  );
}

function groupTotal(a: string) {
  return a.replace(/\.00$/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function Figure({ label, amount, tone }: { label: string; amount: string; tone?: string }) {
  return (
    <div className={`hero-figure${tone ? ` fig-${tone}` : ''}`}>
      <dt>{label}</dt>
      <dd>
        <Money amount={amount} size="lg" />
      </dd>
    </div>
  );
}

function Today({ summary }: { summary: Summary | undefined }) {
  const { t } = useI18n();
  const approvals = useApprovals();
  const waiting = useWaitingReminders();
  const loading = approvals.isLoading || waiting.isLoading || !summary;

  const items: { key: string; to: string; icon: ReactNode; title: string; hint: string; tone: string }[] = [];
  const pay = approvals.data?.payments.length ?? 0;
  const dis = approvals.data?.disputes.length ?? 0;
  const rem = waiting.data?.reminders.length ?? 0;
  const leg = summary?.statuses.legal_ready?.count ?? 0;
  if (pay) items.push({ key: 'pay', to: '/approvals/payments', icon: <HandCoins size={20} />, title: t('todo.payments', { count: pay }), hint: t('todo.paymentsHint'), tone: 'green' });
  if (dis) items.push({ key: 'dis', to: '/approvals/disputes', icon: <MessageSquareWarning size={20} />, title: t('todo.disputes', { count: dis }), hint: t('todo.disputesHint'), tone: 'red' });
  if (rem) items.push({ key: 'rem', to: '/approvals/reminders', icon: <Send size={20} />, title: t('todo.reminders', { count: rem }), hint: t('todo.remindersHint'), tone: 'active' });
  if (leg) items.push({ key: 'leg', to: '/legal', icon: <Gavel size={20} />, title: t('todo.legal', { count: leg }), hint: t('todo.legalHint'), tone: 'legal' });

  return (
    <section className="panel today" aria-labelledby="today-title">
      <h2 id="today-title" className="panel-title">
        {t('overview.today')}
      </h2>
      {loading ? (
        <Loading rows={3} />
      ) : items.length === 0 ? (
        <p className="today-empty">{t('overview.todayEmpty')}</p>
      ) : (
        <ul className="todo">
          {items.map((i) => (
            <li key={i.key}>
              <Link to={i.to} className="todo-row">
                <span className={`todo-icon tone-${i.tone}`} aria-hidden="true">
                  {i.icon}
                </span>
                <span className="todo-text">
                  <span className="todo-title">{i.title}</span>
                  <span className="todo-hint">{i.hint}</span>
                </span>
                <ArrowUpRight size={18} className="todo-go flip-rtl" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Pipeline({ summary }: { summary: Summary | undefined }) {
  const { t } = useI18n();
  if (!summary) {
    return (
      <section className="panel pipeline">
        <Loading rows={4} />
      </section>
    );
  }
  const groups = PIPELINE.map((status) => {
    const s = summary.statuses[status];
    return { status, count: s?.count ?? 0, amount: s?.outstanding ?? '0.00' };
  }).filter((g) => g.count > 0);
  const total = sum(groups.map((g) => g.amount));

  return (
    <section className="panel pipeline" aria-labelledby="pipe-title">
      <div className="panel-head">
        <h2 id="pipe-title" className="panel-title">
          {t('overview.pipeline')}
        </h2>
        <p className="panel-hint">{t('overview.pipelineHint')}</p>
      </div>
      <div className="stack" aria-hidden="true">
        {groups.map((g) => (
          <span key={g.status} className={`stack-part st-${g.status}`} style={{ flexGrow: Number(share(g.amount, total) ?? 0) }} />
        ))}
      </div>
      <ul className="legend">
        {groups.map((g) => (
          <li key={g.status}>
            <Link to={`/debtors?status=${g.status}`} className="legend-row">
              <StatusBadge status={g.status} />
              <span className="legend-count">{g.count}</span>
              <Money amount={g.amount} />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Enforceability({ pct, paper }: { pct: string | null; paper: number }) {
  const { t } = useI18n();
  return (
    <section className="strip" aria-label={t('instrument.enforceable')}>
      <span className="strip-item">
        <ShieldCheck size={20} aria-hidden="true" className="strip-icon" />
        {pct === null ? t('overview.enforceableNone') : t('overview.enforceable', { pct })}
      </span>
      {paper > 0 && (
        <span className="strip-item strip-warn">
          <TriangleAlert size={18} aria-hidden="true" />
          {t('overview.paperRisk', { count: paper })}
        </span>
      )}
    </section>
  );
}

const KIND_ICON = {
  payment_to_review: HandCoins,
  reply: Bell,
  dispute: MessageSquareWarning,
  legal_ready: Gavel,
  promise_broken: TriangleAlert,
  system: Bell,
} as const;

function Activity() {
  const { t, relative } = useI18n();
  const notes = useNotifications();
  return (
    <section className="panel activity" aria-labelledby="act-title">
      <div className="panel-head">
        <h2 id="act-title" className="panel-title">
          {t('overview.activity')}
        </h2>
        <Link to="/notifications" className="link">
          {t('overview.seeAll')}
        </Link>
      </div>
      {!notes.data ? (
        <Loading rows={4} />
      ) : notes.data.items.length === 0 ? (
        <p className="today-empty">{t('notes.empty')}</p>
      ) : (
        <ol className="feed">
          {notes.data.items.slice(0, 5).map((n) => {
            const Icon = KIND_ICON[n.kind as keyof typeof KIND_ICON] ?? Bell;
            const to = notificationLink(n);
            return (
              <li key={n.id} className={n.read_at ? 'feed-row' : 'feed-row feed-unread'}>
                <Icon size={17} aria-hidden="true" className={`feed-icon kind-${n.kind}`} />
                <span className="feed-text">{to ? <Link to={to}>{notificationText(n, t)}</Link> : notificationText(n, t)}</span>
                <time className="feed-time" dateTime={n.created_at}>
                  {relative(n.created_at)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
