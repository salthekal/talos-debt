import { CheckCircle2, ChevronRight, Download, FileText, Gavel, Landmark, RefreshCw } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useLegal, useSource } from '../api/hooks';
import type { LegalRow, LegalStage } from '../api/types';
import { useCanEdit } from '../components/actions';
import { Empty, ErrorState, Initials, Loading, Money } from '../components/bits';
import { NajizCheckDialog, NajizFilingDialog } from '../components/NajizFiling';
import { useI18n, type MessageKey } from '../i18n';
import { sum } from '../lib/money';
import { najizMeaning } from '../lib/najiz';

/** Stages of a case whose request is on Najiz and still open there. */
const ON_NAJIZ: LegalStage[] = ['submitted', 'order_issued', 'measures_applied'];

const TABS = ['file', 'filed'] as const;
type Tab = (typeof TABS)[number];
const BEFORE_FILING: LegalStage[] = ['missing', 'to_approve', 'approved', 'filing'];

export const STAGE_TONE: Record<LegalStage, string> = {
  missing: 'badge-amber',
  to_approve: 'badge-active',
  approved: 'badge-green',
  filing: 'badge-legal',
  submitted: 'badge-legal',
  order_issued: 'badge-legal',
  measures_applied: 'badge-legal',
  settled: 'badge-green',
  closed: 'badge-neutral',
  withdrawn: 'badge-neutral',
};

export function StageBadge({ row }: { row: Pick<LegalRow, 'stage' | 'missing'> }) {
  const { t } = useI18n();
  return (
    <span className={`badge ${STAGE_TONE[row.stage]}`}>
      <span className="badge-dot" aria-hidden="true" />
      {row.stage === 'missing' ? t('legal.stage.missing', { count: row.missing.length }) : t(`legal.stage.${row.stage}` as MessageKey)}
    </span>
  );
}

/**
 * Debts that reached the end of their reminders with no reply, on their way
 * to an execution request on Najiz: check the details, approve, sign in with
 * the owner's Nafath, file, then follow each request (Phase 5).
 */
export function LegalPage() {
  const { t } = useI18n();
  const { tab: tabParam } = useParams();
  const tab: Tab = tabParam === 'filed' ? 'filed' : 'file';
  const navigate = useNavigate();
  const legal = useLegal();
  const canEdit = useCanEdit();
  const source = useSource();
  const rows = legal.data ?? [];
  const toFile = rows.filter((r) => BEFORE_FILING.includes(r.stage));
  const filed = rows.filter((r) => !BEFORE_FILING.includes(r.stage));
  const approved = toFile.filter((r) => r.stage === 'approved');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const chosen = picked ?? new Set(approved.map((r) => r.debt_id));
  const [filing, setFiling] = useState<LegalRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  // Requests on Najiz that are still open there (5.5).
  const toCheck = filed.filter((r) => ON_NAJIZ.includes(r.stage) && r.najiz_request_number);

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const rtl = document.documentElement.dir === 'rtl';
    const next = TABS[(TABS.indexOf(tab) + (rtl ? -step : step) + TABS.length) % TABS.length]!;
    navigate(next === 'file' ? '/legal' : '/legal/filed');
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };

  const counts: Record<Tab, number> = { file: toFile.length, filed: filed.length };
  const toFileNow = approved.filter((r) => chosen.has(r.debt_id));

  return (
    <div className="page legal">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('legal.title')}</h1>
          <p className="page-sub">{t('legal.lead')}</p>
        </div>
        {canEdit && tab === 'filed' && toCheck.length > 0 && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setChecking(true)}>
              <RefreshCw size={17} aria-hidden="true" />
              {t('check.button')}
            </button>
          </div>
        )}
        {canEdit && tab === 'file' && approved.length > 0 && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" disabled={toFileNow.length === 0} onClick={() => setFiling(toFileNow)}>
              <Landmark size={17} aria-hidden="true" />
              {t('legal.fileSelected', { count: toFileNow.length })}
            </button>
          </div>
        )}
      </header>

      <div className="legal-top">
        <ol className="legal-how" aria-label={t('legal.how')}>
          {(['check', 'approve', 'nafath', 'file'] as const).map((k, i) => {
            return (
              <li key={k}>
                <span className="legal-how-num" aria-hidden="true">{i + 1}</span>
                <span>
                  <strong>{t(`legal.how.${k}` as MessageKey)}</strong>
                  <span className="muted">{t(`legal.how.${k}Hint` as MessageKey)}</span>
                </span>
              </li>
            );
          })}
        </ol>
        <aside className="tpl-card">
          <FileText size={22} aria-hidden="true" />
          <div>
            <h2>{t('legal.template.title')}</h2>
            <p>{t('legal.template.hint')}</p>
          </div>
          <a className="btn btn-quiet btn-small" href={source.noteTemplateUrl()} download="promissory-note-template.docx">
            <Download size={16} aria-hidden="true" />
            {t('legal.template.download')}
          </a>
        </aside>
      </div>

      <div className="tabs" role="tablist" aria-label={t('legal.title')} onKeyDown={onKey}>
        {TABS.map((x) => (
          <Link
            key={x}
            id={`tab-${x}`}
            to={x === 'file' ? '/legal' : '/legal/filed'}
            role="tab"
            aria-selected={tab === x}
            aria-controls={`panel-${x}`}
            tabIndex={tab === x ? 0 : -1}
            className="tab"
          >
            {x === 'file' ? <Gavel size={17} aria-hidden="true" /> : <Landmark size={17} aria-hidden="true" />}
            {t(`legal.tab.${x}` as MessageKey)}
            {counts[x] ? <span className="tab-count">{counts[x]}</span> : null}
          </Link>
        ))}
      </div>

      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="panel table-panel tab-panel">
        {legal.isError ? (
          <ErrorState onRetry={() => legal.refetch()} />
        ) : !legal.data ? (
          <Loading rows={5} />
        ) : tab === 'file' ? (
          toFile.length === 0 ? (
            <Empty>{t('legal.empty')}</Empty>
          ) : (
            <ToFileTable
              rows={toFile}
              canEdit={canEdit}
              chosen={chosen}
              onToggle={(id) => {
                const n = new Set(chosen);
                if (n.has(id)) n.delete(id);
                else n.add(id);
                setPicked(n);
              }}
            />
          )
        ) : filed.length === 0 ? (
          <Empty>{t('legal.filedEmpty')}</Empty>
        ) : (
          <FiledTable rows={filed} />
        )}
      </section>

      {tab === 'filed' && filed.length > 0 && <p className="legal-foot muted">{t('legal.checksHint')}</p>}

      {checking && <NajizCheckDialog rows={toCheck} onClose={() => setChecking(false)} />}
      {filing && <NajizFilingDialog rows={filing} onClose={() => (setFiling(null), setPicked(null))} />}
    </div>
  );
}

function ToFileTable({ rows, canEdit, chosen, onToggle }: { rows: LegalRow[]; canEdit: boolean; chosen: Set<string>; onToggle: (id: string) => void }) {
  const { t } = useI18n();
  const total = useMemo(() => sum(rows.map((r) => r.amount_outstanding)), [rows]);
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            {canEdit && (
              <th scope="col" className="col-check">
                <span className="visually-hidden">{t('legal.col.pick')}</span>
              </th>
            )}
            <th scope="col">{t('debtors.col.debtor')}</th>
            <th scope="col" className="num">{t('legal.col.claim')}</th>
            <th scope="col">{t('debtors.col.document')}</th>
            <th scope="col">{t('legal.col.stage')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('legal.col.open')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.debt_id}>
              {canEdit && (
                <td className="col-check">
                  {r.stage === 'approved' && (
                    <label className="check">
                      <input type="checkbox" checked={chosen.has(r.debt_id)} onChange={() => onToggle(r.debt_id)} aria-label={t('legal.pick', { name: r.full_name })} />
                    </label>
                  )}
                </td>
              )}
              <td>
                <div className="who-cell">
                  <Initials name={r.full_name} />
                  <span>
                    <Link to={`/legal/case/${r.debt_id}`} className="row-title">
                      {r.full_name}
                    </Link>
                    <span className="ref">{r.ref_code}</span>
                  </span>
                </div>
              </td>
              <td className="num">
                <Money amount={r.amount_outstanding} />
              </td>
              <td>{t(`instrument.${r.instrument_type}` as MessageKey)}</td>
              <td>
                <StageBadge row={r} />
              </td>
              <td className="num">
                <Link to={`/legal/case/${r.debt_id}`} className="btn btn-quiet btn-small">
                  {t(r.stage === 'missing' ? 'legal.fillIn' : r.stage === 'to_approve' ? 'legal.review' : 'legal.open')}
                  <ChevronRight size={15} aria-hidden="true" className="flip-rtl" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            {canEdit && <td />}
            <td>{t('legal.total', { count: rows.length })}</td>
            <td className="num">
              <Money amount={total} />
            </td>
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function FiledTable({ rows }: { rows: LegalRow[] }) {
  const { t, relative } = useI18n();
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t('debtors.col.debtor')}</th>
            <th scope="col" className="num">{t('legal.col.claim')}</th>
            <th scope="col">{t('legal.col.request')}</th>
            <th scope="col">{t('legal.col.najizStatus')}</th>
            <th scope="col">{t('legal.col.filed')}</th>
            <th scope="col">{t('legal.col.checked')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.debt_id}>
              <td>
                <div className="who-cell">
                  <Initials name={r.full_name} />
                  <span>
                    <Link to={`/legal/case/${r.debt_id}`} className="row-title">
                      {r.full_name}
                    </Link>
                    <span className="ref">{r.ref_code}</span>
                  </span>
                </div>
              </td>
              <td className="num">
                <Money amount={r.amount_outstanding} />
              </td>
              <td className="code">
                <bdi dir="ltr">{r.najiz_request_number}</bdi>
              </td>
              <td>
                <div className="najiz-cell">
                  <span className="najiz-status">
                    <CheckCircle2 size={15} aria-hidden="true" />
                    <span lang="ar" dir="rtl">{r.najiz_status}</span>
                  </span>
                  {najizMeaning(r.najiz_status) && <span className="muted najiz-meaning">{t(najizMeaning(r.najiz_status)!)}</span>}
                  {r.najiz_circuit && (
                    <span className="muted najiz-circuit" lang="ar" dir="rtl">
                      {r.najiz_circuit}
                    </span>
                  )}
                </div>
              </td>
              <td className="muted">{relative(r.submitted_at)}</td>
              <td className="muted">{relative(r.najiz_status_checked_at) ?? t('legal.notChecked')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
