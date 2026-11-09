import { Gavel, ShieldCheck, ShieldOff } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useDebts, useRules } from '../api/hooks';
import { Empty, ErrorState, Initials, Loading, Money, ReminderDots, StatusBadge } from '../components/bits';
import { useI18n, type MessageKey } from '../i18n';

/**
 * Debts that reached the end of their reminders with no reply. Phase 5 adds
 * the filing pack, client approval and Najiz tracking here.
 */
export function LegalPage() {
  const { t, relative } = useI18n();
  const ready = useDebts({ status: 'legal_ready', limit: 200 });
  const inLegal = useDebts({ status: 'in_legal', limit: 200 });
  const rules = useRules();
  const max = rules.data?.max_attempts ?? 5;
  const rows = [...(ready.data?.items ?? []), ...(inLegal.data?.items ?? [])];
  const loading = !ready.data || !inLegal.data;

  return (
    <div className="page legal">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('legal.title')}</h1>
          <p className="page-sub">{t('legal.lead')}</p>
        </div>
      </header>

      <aside className="callout callout-legal">
        <Gavel size={20} aria-hidden="true" />
        <p>{t('legal.soon')}</p>
      </aside>

      <section className="panel table-panel">
        {ready.isError || inLegal.isError ? (
          <ErrorState onRetry={() => (ready.refetch(), inLegal.refetch())} />
        ) : loading ? (
          <Loading rows={5} />
        ) : rows.length === 0 ? (
          <Empty>{t('legal.empty')}</Empty>
        ) : (
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
                {rows.map((d) => (
                  <tr key={d.debt_id}>
                    <td>
                      <div className="who-cell">
                        <Initials name={d.full_name} />
                        <span>
                          <Link to={`/debtors/${d.debtor_id}`} className="row-title">
                            {d.full_name}
                          </Link>
                          <span className="ref">{d.ref_code}</span>
                        </span>
                      </div>
                    </td>
                    <td className="num">
                      <Money amount={d.amount_outstanding} />
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
                        {t(`instrument.${d.instrument_type}` as MessageKey)}
                      </span>
                    </td>
                    <td className="muted">{relative(d.last_contact_at) ?? t('debtors.never')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
