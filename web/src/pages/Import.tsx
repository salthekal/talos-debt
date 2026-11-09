import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, TriangleAlert, UploadCloud, XCircle } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { useConfirmImport, useSource } from '../api/hooks';
import type { ImportIssue, ImportReport } from '../api/types';
import { useCanEdit } from '../components/actions';
import { Money } from '../components/bits';
import { FormError, errorText, useToast } from '../components/ui';
import { useI18n } from '../i18n';

const MAX_BYTES = 5 * 1024 * 1024;

export function ImportPage() {
  const { t } = useI18n();
  const source = useSource();
  const toast = useToast();
  const canEdit = useCanEdit();
  const input = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState<ImportReport | null>(null);

  const upload = useMutation({ mutationFn: (f: File) => source.uploadImport(f) });
  const confirm = useConfirmImport();
  const cancel = useMutation({ mutationFn: (id: string) => source.cancelImport(id) });

  const take = (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    setReport(null);
    setDone(null);
    if (!/\.xlsx$/i.test(file.name)) return setProblem(t('import.wrongType'));
    if (file.size > MAX_BYTES) return setProblem(t('error.too_large'));
    setFileName(file.name);
    upload.mutate(file, {
      onSuccess: setReport,
      onError: (err) => setProblem(errorText(err, t)),
    });
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    take(e.dataTransfer.files[0]);
  };

  const reset = () => {
    setReport(null);
    setFileName(null);
    setProblem(null);
    setDone(null);
    if (input.current) input.current.value = '';
  };

  if (!canEdit) {
    return (
      <div className="page">
        <h1 className="page-title">{t('import.title')}</h1>
        <p className="page-sub">{t('error.forbidden')}</p>
      </div>
    );
  }

  return (
    <div className="page import">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('import.title')}</h1>
          <p className="page-sub">{t('import.lead')}</p>
        </div>
      </header>

      {done ? (
        <section className="panel import-done" role="status">
          <CheckCircle2 size={36} aria-hidden="true" className="import-done-icon" />
          <h2 className="panel-title">{t('import.done', { count: done.summary?.debts ?? 0 })}</h2>
          <p>
            <Money amount={done.summary?.total_amount ?? '0.00'} size="lg" />
          </p>
          <div className="form-actions form-actions-center">
            <button type="button" className="btn btn-quiet" onClick={reset}>
              {t('import.another')}
            </button>
            <Link to="/debtors" className="btn btn-primary">
              {t('nav.debtors')}
            </Link>
          </div>
        </section>
      ) : (
        <ol className="steps">
          <li className="step panel">
            <span className="step-num" aria-hidden="true">1</span>
            <div className="step-body">
              <h2 className="step-title">{t('import.step1')}</h2>
              <p className="step-hint">{t('import.step1Hint')}</p>
              <a className="btn btn-quiet" href={source.importTemplateUrl()} download="talos-import-template.xlsx">
                <Download size={17} aria-hidden="true" />
                {t('import.download')}
              </a>
            </div>
          </li>

          <li className="step panel">
            <span className="step-num" aria-hidden="true">2</span>
            <div className="step-body">
              <h2 className="step-title">{t('import.step2')}</h2>
              <p className="step-hint">{t('import.step2Hint')}</p>
              <label
                className={`drop${dragging ? ' drop-over' : ''}${upload.isPending ? ' drop-busy' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <input
                  ref={input}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="sr-only"
                  onChange={(e) => take(e.target.files?.[0])}
                  disabled={upload.isPending}
                />
                {upload.isPending ? (
                  <>
                    <FileSpreadsheet size={28} aria-hidden="true" className="drop-icon pulse" />
                    <span role="status">{t('import.checking', { file: fileName ?? '' })}</span>
                  </>
                ) : (
                  <>
                    <UploadCloud size={28} aria-hidden="true" className="drop-icon" />
                    <span className="drop-main">{t('import.choose')}</span>
                    <span className="drop-sub">{t('import.drop')}</span>
                  </>
                )}
              </label>
              <FormError message={problem} />
            </div>
          </li>

          <li className={`step panel${report ? '' : ' step-later'}`}>
            <span className="step-num" aria-hidden="true">3</span>
            <div className="step-body">
              <h2 className="step-title">{t('import.step3')}</h2>
              {report && (
                <Report
                  report={report}
                  busy={confirm.isPending || cancel.isPending}
                  onConfirm={() =>
                    confirm.mutate(report.id, {
                      onSuccess: (r) => {
                        setDone({ ...report, ...r, summary: r.summary ?? report.summary });
                        toast(t('import.done', { count: report.summary?.debts ?? 0 }));
                      },
                      onError: (err) => setProblem(errorText(err, t)),
                    })
                  }
                  onCancel={() => cancel.mutate(report.id, { onSettled: reset })}
                />
              )}
            </div>
          </li>
        </ol>
      )}
    </div>
  );
}

function Report({ report, busy, onConfirm, onCancel }: { report: ImportReport; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const s = report.summary;
  const errors = report.errors ?? [];
  const warnings = report.warnings ?? [];
  const ok = report.status === 'ready' && errors.length === 0;
  return (
    <div className="report">
      <p className={`report-verdict ${ok ? 'verdict-ok' : 'verdict-bad'}`}>
        {ok ? <CheckCircle2 size={20} aria-hidden="true" /> : <XCircle size={20} aria-hidden="true" />}
        <span>
          <strong>{ok ? t('import.ready') : t('import.failed', { count: errors.length })}</strong>
          <span className="report-file">{report.file_name}</span>
        </span>
      </p>
      {s && (
        <dl className="report-figures">
          <div>
            <dt>{t('import.rows')}</dt>
            <dd>{s.rows}</dd>
          </div>
          <div>
            <dt>{t('import.newDebtors')}</dt>
            <dd>{s.debtors_new}</dd>
          </div>
          <div>
            <dt>{t('import.existing')}</dt>
            <dd>{s.debtors_existing}</dd>
          </div>
          <div>
            <dt>{t('import.debts')}</dt>
            <dd>{s.debts}</dd>
          </div>
          <div className="report-money">
            <dt>{t('import.total')}</dt>
            <dd>
              <Money amount={s.total_amount} />
            </dd>
          </div>
          <div className="report-money">
            <dt>{t('import.enforceable')}</dt>
            <dd>
              <Money amount={s.enforceable_amount} />
            </dd>
          </div>
        </dl>
      )}
      {errors.length > 0 && <Issues title={t('import.errors')} items={errors} tone="bad" />}
      {warnings.length > 0 && <Issues title={t('import.warnings')} items={warnings} tone="warn" />}
      <div className="form-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>
          {t('import.cancel')}
        </button>
        {ok && s && (
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {t('import.confirm', { count: s.debts })}
          </button>
        )}
      </div>
    </div>
  );
}

function Issues({ title, items, tone }: { title: string; items: ImportIssue[]; tone: 'bad' | 'warn' }) {
  const { t } = useI18n();
  return (
    <section className={`issues issues-${tone}`}>
      <h3 className="issues-title">
        {tone === 'bad' ? <XCircle size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
        {title} ({items.length})
      </h3>
      <ul>
        {items.slice(0, 200).map((i, n) => (
          <li key={n}>
            {i.row !== null && <span className="issue-row">{t('import.row', { row: i.row })}</span>}
            {i.column && <span className="issue-col">{i.column}</span>}
            <span className="issue-msg">{i.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
