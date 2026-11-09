import { ChevronLeft, ChevronRight, FileSpreadsheet, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react';
import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useDebts, useRules, useStatusCounts } from '../api/hooks';
import { DEBT_STATUSES, type DebtStatus } from '../api/types';
import { Empty, ErrorState, Initials, Loading, Money, PaidBar, ReminderDots, StatusBadge } from '../components/bits';
import { useI18n } from '../i18n';
import { share, subtract } from '../lib/money';

const PAGE = 25;
/** The filters shown, in the order a debt moves. Rare statuses are reached from "All". */
const FILTERS: DebtStatus[] = ['open', 'in_follow_up', 'promised', 'partly_paid', 'disputed', 'paused', 'legal_ready', 'in_legal', 'paid'];

export function DebtorsPage() {
  const { t, relative } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get('status');
  const status = DEBT_STATUSES.includes(statusParam as DebtStatus) ? (statusParam as DebtStatus) : undefined;
  const search = params.get('search') ?? undefined;
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);

  const query = useMemo(() => ({ status, search, limit: PAGE, offset }), [status, search, offset]);
  const debts = useDebts(query);
  const counts = useStatusCounts();
  const rules = useRules();
  const max = rules.data?.max_attempts ?? 5;
  const all = Object.values(counts.data ?? {}).reduce((a, b) => a + (b ?? 0), 0);

  const setFilter = (s?: DebtStatus) => {
    const next = new URLSearchParams(params);
    if (s) next.set('status', s);
    else next.delete('status');
    next.delete('offset');
    setParams(next);
  };
  const page = (dir: 1 | -1) => {
    const next = new URLSearchParams(params);
    next.set('offset', String(Math.max(0, offset + dir * PAGE)));
    setParams(next);
  };

  return (
    <div className="page debtors">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('debtors.title')}</h1>
          {debts.data && <p className="page-sub">{t('debtors.count', { count: debts.data.total })}</p>}
        </div>
        <div className="page-actions">
          <Link to="/import" className="btn btn-quiet">
            <FileSpreadsheet size={17} aria-hidden="true" />
            {t('debtors.import')}
          </Link>
          <button type="button" className="btn btn-primary">
            <UserPlus size={17} aria-hidden="true" />
            {t('debtors.add')}
          </button>
        </div>
      </header>

      <div className="filters" role="group" aria-label={t('debtors.col.status')}>
        <button type="button" className="chip" aria-pressed={!status} onClick={() => setFilter()}>
          {t('debtors.all')}
          <span className="chip-count">{all}</span>
        </button>
        {FILTERS.filter((s) => counts.data?.[s]).map((s) => (
          <button key={s} type="button" className={`chip chip-${s}`} aria-pressed={status === s} onClick={() => setFilter(s)}>
            {t(`status.${s}`)}
            <span className="chip-count">{counts.data?.[s]}</span>
          </button>
        ))}
      </div>

      <section className="panel table-panel">
        {debts.isError ? (
          <ErrorState onRetry={() => debts.refetch()} />
        ) : !debts.data ? (
          <Loading rows={8} />
        ) : debts.data.items.length === 0 ? (
          <Empty>{status || search ? t('debtors.empty') : t('debtors.emptyAll')}</Empty>
        ) : (
          <>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('debtors.col.debtor')}</th>
                    <th scope="col" className="num">{t('debtors.col.outstanding')}</th>
                    <th scope="col">{t('debtors.col.status')}</th>
                    <th scope="col">{t('debtors.col.reminders')}</th>
                    <th scope="col">{t('debtors.col.document')}</th>
                    <th scope="col">{t('debtors.col.lastContact')}</th>
                  </tr>
                </thead>
                <tbody>
                  {debts.data.items.map((d) => {
                    const paid = share(subtract(d.amount_original, d.amount_outstanding), d.amount_original);
                    const open = () => navigate(`/debtors/${d.debtor_id}`);
                    return (
                      <tr key={d.debt_id} className="row-link" onClick={open}>
                        <td>
                          <div className="who-cell">
                            <Initials name={d.full_name} />
                            <span>
                              <Link to={`/debtors/${d.debtor_id}`} className="row-title" onClick={(e) => e.stopPropagation()}>
                                {d.full_name}
                              </Link>
                              <span className="ref">{d.ref_code}</span>
                            </span>
                          </div>
                        </td>
                        <td className="num">
                          <Money amount={d.amount_outstanding} />
                          {paid && paid !== '0.0' ? (
                            <span className="paid-line">
                              <PaidBar pct={paid} />
                              <span className="paid-pct">{t('debtors.paidShare', { pct: paid })}</span>
                            </span>
                          ) : null}
                        </td>
                        <td>
                          <StatusBadge status={d.status} />
                        </td>
                        <td>
                          <ReminderDots sent={Math.min(d.attempts_count, max)} max={max} />
                        </td>
                        <td>
                          <span className={`doc${d.directly_enforceable ? ' doc-ok' : ''}`} title={t(d.directly_enforceable ? 'instrument.enforceable' : 'instrument.notEnforceable')}>
                            {d.directly_enforceable ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldOff size={16} aria-hidden="true" />}
                            {t(`instrument.${d.instrument_type}` as Parameters<typeof t>[0])}
                          </span>
                        </td>
                        <td className="muted">{relative(d.last_contact_at) ?? t('debtors.never')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {debts.data.total > PAGE && (
              <nav className="pager" aria-label={t('debtors.title')}>
                <span>
                  {t('debtors.showing', { from: offset + 1, to: Math.min(offset + PAGE, debts.data.total), total: debts.data.total })}
                </span>
                <button type="button" className="icon-btn" onClick={() => page(-1)} disabled={offset === 0} aria-label={t('debtors.prev')}>
                  <ChevronLeft size={18} className="flip-rtl" />
                </button>
                <button type="button" className="icon-btn" onClick={() => page(1)} disabled={offset + PAGE >= debts.data.total} aria-label={t('debtors.next')}>
                  <ChevronRight size={18} className="flip-rtl" />
                </button>
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
}
