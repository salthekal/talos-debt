import { FileImage, FileText, Upload } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useDocuments, useSource, useUploadDocument } from '../api/hooks';
import type { DebtRow, DocType, DocumentInfo } from '../api/types';
import { useI18n, type MessageKey } from '../i18n';
import { useCanEdit } from './actions';
import { Loading } from './bits';
import { Dialog, Field, FormError, errorText, useToast } from './ui';

const TYPES: DocType[] = [
  'promissory_note', 'cheque', 'contract', 'employment_contract', 'invoice', 'judgment',
  'iqama', 'national_id', 'receipt', 'payment_proof', 'other',
];
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/jpeg,image/png,image/webp,image/heic';

function size(bytes: number | string) {
  const n = Number(bytes); // a file size, not money
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The debtor's documents (step 3.4): the evidence that goes into the legal file. */
export function Documents({ debtorId, name, debts }: { debtorId: string; name: string; debts: DebtRow[] }) {
  const { t, formatDate } = useI18n();
  const docs = useDocuments(debtorId);
  const source = useSource();
  const canEdit = useCanEdit();
  const [adding, setAdding] = useState(false);
  const refOf = new Map(debts.map((d) => [d.debt_id, d.ref_code]));

  return (
    <section className="panel docs" aria-labelledby="docs-title">
      <div className="docs-head">
        <h2 id="docs-title" className="section-title">
          {t('docs.title')}
        </h2>
        {canEdit && (
          <button type="button" className="btn btn-link btn-small" onClick={() => setAdding(true)}>
            <Upload size={15} aria-hidden="true" />
            {t('docs.add')}
          </button>
        )}
      </div>
      {!docs.data ? (
        <Loading rows={2} />
      ) : docs.data.length === 0 ? (
        <p className="docs-empty">{t('docs.empty')}</p>
      ) : (
        <ul className="doc-list">
          {docs.data.map((d: DocumentInfo) => {
            const Icon = d.mime_type.startsWith('image/') ? FileImage : FileText;
            const url = source.documentUrl(d.id);
            const label = t(`doctype.${d.doc_type}` as MessageKey);
            const ref = d.debt_id ? refOf.get(d.debt_id) : undefined;
            return (
              <li key={d.id} className="doc-row">
                <Icon size={18} aria-hidden="true" className="doc-icon" />
                <span className="doc-text">
                  <span className="doc-type">
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" aria-label={t('docs.download', { file: d.file_name })}>
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                    {ref && <span className="ref">{ref}</span>}
                  </span>
                  <span className="doc-meta">
                    <bdi>{d.file_name}</bdi> · {size(d.size_bytes)} · {formatDate(d.created_at)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <AddDocument debtorId={debtorId} name={name} debts={debts} onClose={() => setAdding(false)} />}
    </section>
  );
}

function AddDocument({ debtorId, name, debts, onClose }: { debtorId: string; name: string; debts: DebtRow[]; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const upload = useUploadDocument();
  const [type, setType] = useState<DocType>('promissory_note');
  const [debtId, setDebtId] = useState(debts.length === 1 ? debts[0]!.debt_id : '');
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<{ file?: string; form?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setErrors({ file: t('common.required') });
    if (!/\.(pdf|jpe?g|png|webp|heic)$/i.test(file.name)) return setErrors({ file: t('docs.wrongType') });
    if (file.size > MAX_BYTES) return setErrors({ file: t('docs.tooBig') });
    setErrors({});
    upload.mutate(
      { debtorId, debtId: debtId || undefined, docType: type, file },
      {
        onSuccess: () => {
          toast(t('docs.done', { file: file.name }));
          onClose();
        },
        onError: (err) => setErrors({ form: errorText(err, t) }),
      },
    );
  };

  return (
    <Dialog open onClose={onClose} title={t('docs.addTitle', { name })}>
      <form className="form" onSubmit={submit} noValidate>
        <Field label={t('docs.type')}>
          {(p) => (
            <select {...p} value={type} onChange={(e) => setType(e.target.value as DocType)}>
              {TYPES.map((x) => (
                <option key={x} value={x}>
                  {t(`doctype.${x}` as MessageKey)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {debts.length > 0 && (
          <Field label={t('docs.debt')}>
            {(p) => (
              <select {...p} value={debtId} onChange={(e) => setDebtId(e.target.value)}>
                <option value="">{t('docs.allDebts')}</option>
                {debts.map((d) => (
                  <option key={d.debt_id} value={d.debt_id}>
                    {d.ref_code}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
        <Field label={t('docs.file')} hint={t('docs.fileHint')} error={errors.file}>
          {(p) => <input {...p} type="file" accept={ACCEPT} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
        <FormError message={errors.form} />
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={upload.isPending} aria-busy={upload.isPending}>
            {t('docs.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
