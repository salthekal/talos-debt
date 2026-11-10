import { AlertCircle, ArrowLeft, Building2, CheckCircle2, CircleDashed, Download, FileStack, FileText, History, Landmark, Pencil, PlusCircle, ScrollText, ShieldCheck, Upload, User as UserIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAddLegalStatus, useApproveFiling, useLegalCase, useMakePack, useMe, useSaveNajizDetails, useSource, useUploadLegalFile } from '../api/hooks';
import { ApiError } from '../api/source';
import type { DocumentInfo, LegalCaseDetail, LegalStatus, NajizField, NajizFileKind, NajizUploadKind } from '../api/types';
import { useCanEdit } from '../components/actions';
import { ErrorState, Initials, Loading, Money } from '../components/bits';
import { NajizFilingDialog } from '../components/NajizFiling';
import { Dialog, Field, FormError, errorText, useToast } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';
import { isZero } from '../lib/money';
import { NotFound } from './NotFound';
import { StageBadge } from './Legal';

/** Najiz takes PDF files of at most 0.95 MB for the company documents. */
const NAJIZ_MAX_BYTES = 950 * 1024;
const SAUDI_CITIES = ['Jeddah', 'Riyadh', 'Makkah', 'Madinah', 'Dammam', 'Khobar', 'Taif', 'Tabuk', 'Hail', 'Buraydah', 'Abha', 'Jazan', 'Najran', 'Yanbu'];
const MANUAL_STATUSES: LegalStatus[] = ['submitted', 'order_issued', 'measures_applied', 'settled', 'closed', 'withdrawn'];

const mask = (id: string) => `•••• ${id.slice(-4)}`;

function region(code: string | null, locale: string) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale.startsWith('ar') ? 'ar' : 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function LegalCasePage() {
  const { debtId = '' } = useParams();
  const { t, locale, formatDate } = useI18n();
  const detail = useLegalCase(debtId);
  const canEdit = useCanEdit();
  const me = useMe();
  const canCompany = me.data?.user.role === 'owner' || me.data?.user.role === 'admin';
  const [dialog, setDialog] = useState<'company' | 'name' | 'note' | 'status' | 'file' | null>(null);

  if (detail.isError) {
    const e = detail.error;
    return e instanceof ApiError && e.status === 404 ? <NotFound /> : <div className="page"><ErrorState onRetry={() => detail.refetch()} /></div>;
  }
  if (!detail.data) {
    return (
      <div className="page">
        <Loading rows={6} />
      </div>
    );
  }
  const c = detail.data;
  const { row } = c;
  const missing = new Set(row.missing);
  const before = ['missing', 'to_approve'].includes(row.stage);

  return (
    <div className="page legal-case">
      <Link to={before || row.stage === 'approved' || row.stage === 'filing' ? '/legal' : '/legal/filed'} className="back">
        <ArrowLeft size={16} aria-hidden="true" className="flip-rtl" />
        {t('case.back')}
      </Link>

      <header className="debtor-head">
        <Initials name={row.full_name} />
        <div className="debtor-id">
          <h1 className="page-title">{row.full_name}</h1>
          <p className="case-sub">
            <span className="ref">{row.ref_code}</span>
            <StageBadge row={row} />
          </p>
        </div>
        <div className="case-claim">
          <span className="case-claim-label">{t('case.claim')}</span>
          <Money amount={c.amounts.claimed} size="lg" />
        </div>
      </header>

      <Readiness c={c} />

      <div className="case-grid">
        <div className="case-main">
          <Section
            icon={<Building2 size={18} />}
            title={t('case.company')}
            hint={t('case.companyHint')}
            action={canCompany ? <EditButton label={t('case.editCompany')} onClick={() => setDialog('company')} /> : null}
          >
            <Line label={t('case.companyName')} value={c.company.legal_name} />
            <Line label={t('case.unified')} value={c.company.unified_number && <bdi dir="ltr" className="code">{c.company.unified_number}</bdi>} missing={missing.has('unified_number')} />
            <Line
              label={t('case.owner')}
              value={c.company.owner_id_last4 && (
                <>
                  {c.company.owner_name} <span className="muted">· {t(`idtype.${c.company.owner_id_type ?? 'national_id'}` as MessageKey)} <bdi dir="ltr" className="code">•••• {c.company.owner_id_last4}</bdi></span>
                </>
              )}
              missing={missing.has('owner_id')}
            />
            <Line label={t('case.representation')} value={t('case.legalRepresentative')} />
            <Line label={t('case.bank')} value={c.company.iban && (<>{c.company.bank_name} · <bdi dir="ltr" className="code">{c.company.iban}</bdi></>)} missing={missing.has('iban')} />
            <FileLine kind="cr" doc={c.files.cr} missing={missing.has('cr_file')} upload={canEdit ? c.row.debt_id : undefined} />
            <FileLine kind="establishment_contract" doc={c.files.establishment_contract} missing={missing.has('contract_file')} optional upload={canEdit ? c.row.debt_id : undefined} />
            <FileLine kind="partners_decision" doc={c.files.partners_decision} optional />
          </Section>

          <Section
            icon={<UserIcon size={18} />}
            title={t('case.debtor')}
            hint={t('case.debtorHint')}
            action={canEdit && before ? <EditButton label={t('case.editName')} onClick={() => setDialog('name')} /> : null}
          >
            <Line
              label={t('case.nameParts')}
              value={c.debtor.first_name && (
                <span dir="auto">
                  {[c.debtor.first_name, c.debtor.father_name, c.debtor.grandfather_name, c.debtor.family_name].filter(Boolean).join(' ')}
                </span>
              )}
              missing={missing.has('debtor_name')}
              missingText={t('case.nameMissing', { name: c.debtor.full_name })}
            />
            <Line label={t('case.idNumber')} value={<>{t(`idtype.${c.debtor.id_type}` as MessageKey)} <bdi dir="ltr" className="code">{mask(c.debtor.id_number)}</bdi></>} missing={missing.has('debtor_id')} />
            <Line label={t('case.nationality')} value={region(c.debtor.nationality, locale)} missing={missing.has('debtor_nationality')} />
            <Line label={t('case.mobile')} value={c.debtor.phone && <bdi dir="ltr" className="code">{c.debtor.phone}</bdi>} optional />
          </Section>

          <Section
            icon={<ScrollText size={18} />}
            title={t('case.note')}
            hint={t('case.noteHint')}
            action={canEdit && before ? <EditButton label={t('case.editNote')} onClick={() => setDialog('note')} /> : null}
          >
            <Line label={t('case.noteType')} value={t(`instrument.${c.note.type}` as MessageKey)} />
            <Line label={t('case.noteNumber')} value={c.note.reference_number && <bdi dir="ltr" className="code">{c.note.reference_number}</bdi>} optional />
            <NoteDates c={c} missing={missing} />
            <Line
              label={t('case.place')}
              value={c.note.issue_city && `${c.note.issue_city}, ${region(c.note.issue_country, locale) ?? ''}`}
              missing={missing.has('note_place')}
              missingText={t('case.placeMissing')}
            />
            <Line label={t('case.faceAmount')} value={c.note.face_amount && <Money amount={c.note.face_amount} />} />
            <Line label={t('case.received')} value={isZero(c.amounts.received) ? t('case.receivedNone') : <Money amount={c.amounts.received} />} />
            <Line label={t('case.claim')} value={<strong><Money amount={c.amounts.claimed} /></strong>} />
            {!missing.has('note_type') && <FileLine kind="promissory_note" doc={c.files.promissory_note} missing={missing.has('note_file')} upload={canEdit && before ? c.row.debt_id : undefined} />}
          </Section>
        </div>

        <aside className="case-side">
          {before && <ApproveCard c={c} canEdit={canEdit} />}
          {(row.stage === 'approved' || row.stage === 'filing') && c.approval && (
            <section className="panel case-card case-approved">
              <h2 className="panel-title">
                <ShieldCheck size={18} aria-hidden="true" />
                {t('case.approvedTitle')}
              </h2>
              <p>{t('case.approvedBy', { name: c.approval.approved_by_name, when: formatDate(c.approval.approved_at) })}</p>
              <dl className="mini-facts">
                <div><dt>{t('case.contactEmail')}</dt><dd><bdi dir="ltr">{c.approval.contact_email}</bdi></dd></div>
                <div><dt>{t('case.contactPhone')}</dt><dd><bdi dir="ltr" className="code">{c.approval.contact_phone}</bdi></dd></div>
              </dl>
              {canEdit && row.stage === 'approved' && (
                <button type="button" className="btn btn-primary btn-block" onClick={() => setDialog('file')}>
                  <Landmark size={17} aria-hidden="true" />
                  {t('legal.fileOne')}
                </button>
              )}
              {canEdit && row.stage === 'approved' && (
                <button type="button" className="btn btn-quiet btn-block" onClick={() => setDialog('status')}>
                  <PlusCircle size={17} aria-hidden="true" />
                  {t('case.addStatus')}
                </button>
              )}
              {row.stage === 'filing' && <p className="muted">{t('case.filingNow')}</p>}
            </section>
          )}
          {!before && row.stage !== 'approved' && row.stage !== 'filing' && (
            <section className="panel case-card case-najiz">
              <h2 className="panel-title">
                <Landmark size={18} aria-hidden="true" />
                {t('case.onNajiz')}
              </h2>
              <dl className="mini-facts">
                <div><dt>{t('legal.col.request')}</dt><dd className="code"><bdi dir="ltr">{row.najiz_request_number}</bdi></dd></div>
                <div><dt>{t('legal.col.najizStatus')}</dt><dd lang="ar" dir="rtl">{row.najiz_status}</dd></div>
                {row.najiz_circuit && <div><dt>{t('case.circuit')}</dt><dd lang="ar" dir="rtl">{row.najiz_circuit}</dd></div>}
                <div><dt>{t('case.court')}</dt><dd lang="ar" dir="rtl">محكمة التنفيذ</dd></div>
              </dl>
              {canEdit && (
                <button type="button" className="btn btn-quiet btn-block" onClick={() => setDialog('status')}>
                  <PlusCircle size={17} aria-hidden="true" />
                  {t('case.addStatus')}
                </button>
              )}
            </section>
          )}

          <PackCard c={c} canEdit={canEdit} />

          <section className="panel case-card">
            <h2 className="panel-title">
              <History size={18} aria-hidden="true" />
              {t('case.history')}
            </h2>
            {c.events.length === 0 ? <p className="muted">{t('case.historyEmpty')}</p> : <Events c={c} />}
          </section>
        </aside>
      </div>

      {dialog === 'company' && <CompanyDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'name' && <NameDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'note' && <NoteDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'status' && <StatusDialog c={c} onClose={() => setDialog(null)} />}
      {dialog === 'file' && <NajizFilingDialog rows={[row]} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ------------------------------------------------------------- pieces

function Readiness({ c }: { c: LegalCaseDetail }) {
  const { t } = useI18n();
  const { row } = c;
  if (row.stage === 'missing') {
    return (
      <aside className="callout tone-amber case-ready" role="note">
        <AlertCircle size={20} aria-hidden="true" />
        <div>
          <p><strong>{t('case.missingTitle', { count: row.missing.length })}</strong></p>
          <ul>
            {row.missing.map((m) => (
              <li key={m}>{t(`najiz.field.${m}` as MessageKey)}</li>
            ))}
          </ul>
        </div>
      </aside>
    );
  }
  if (row.stage === 'to_approve') {
    return (
      <aside className="callout case-ready case-ok" role="note">
        <CheckCircle2 size={20} aria-hidden="true" />
        <p>{t('case.completeTitle')}</p>
      </aside>
    );
  }
  return null;
}

function Section({ icon, title, hint, action, children }: { icon: ReactNode; title: string; hint: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel case-section">
      <header className="case-section-head">
        <span className="case-section-icon" aria-hidden="true">{icon}</span>
        <div>
          <h2 className="panel-title">{title}</h2>
          <p className="panel-hint">{hint}</p>
        </div>
        {action}
      </header>
      <dl className="nj-lines">{children}</dl>
    </section>
  );
}

function Line({ label, value, missing, missingText, optional, action }: { label: string; value: ReactNode; missing?: boolean; missingText?: string; optional?: boolean; action?: ReactNode }) {
  const { t } = useI18n();
  const empty = value === null || value === undefined || value === '';
  const bad = missing || (!optional && empty);
  return (
    <div className={`nj-line${bad ? ' nj-missing' : ''}`}>
      <dt>{label}</dt>
      <dd>
        {bad ? (
          <>
            <AlertCircle size={15} aria-hidden="true" />
            <span>{missingText ?? t('case.missing')}</span>
          </>
        ) : empty ? (
          <span className="muted">{t('case.notGiven')}</span>
        ) : (
          <>
            <CheckCircle2 size={15} aria-hidden="true" className="nj-ok" />
            <span>{value}</span>
          </>
        )}
        {action}
      </dd>
    </div>
  );
}

function FileLine({ kind, doc, missing, optional, upload }: { kind: NajizFileKind; doc: DocumentInfo | null; missing?: boolean; optional?: boolean; upload?: string }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const send = useUploadLegalFile();
  const canUpload = upload && kind !== 'partners_decision' && (!doc || missing);
  const size = doc ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(Number(doc.size_bytes) / 1_048_576) : '';
  const tooBig = doc && kind !== 'promissory_note' && Number(doc.size_bytes) > NAJIZ_MAX_BYTES;
  return (
    <Line
      label={t(`case.file.${kind}` as MessageKey)}
      optional={optional}
      missing={missing}
      missingText={t('case.fileMissing')}
      value={doc && (
        <span className="nj-file">
          <FileText size={15} aria-hidden="true" />
          <span>{doc.file_name}</span>
          <span className="muted">{t('case.fileSize', { mb: size })}</span>
          {tooBig && <span className="nj-note">{t('case.fileShrink')}</span>}
        </span>
      )}
      action={canUpload ? (
        <label className={`btn btn-quiet btn-small nj-upload${send.isPending ? ' is-busy' : ''}`}>
          <Upload size={15} aria-hidden="true" />
          {t('case.upload')}
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            aria-label={t('case.uploadOf', { file: t(`case.file.${kind}` as MessageKey) })}
            disabled={send.isPending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
                toast(t('case.pdfOnly'), 'error');
                return;
              }
              send.mutate(
                { debtId: upload!, kind: kind as NajizUploadKind, file },
                { onSuccess: () => toast(t('case.uploaded', { file: file.name })), onError: (err) => toast(errorText(err, t), 'error') },
              );
            }}
          />
        </label>
      ) : null}
    />
  );
}

function NoteDates({ c, missing }: { c: LegalCaseDetail; missing: Set<NajizField> }) {
  const { t, formatDate } = useI18n();
  return (
    <>
      <Line label={t('case.written')} value={c.note.issue_date && formatDate(c.note.issue_date)} missing={missing.has('note_date')} />
      <Line
        label={t('case.due')}
        value={c.note.due_on_demand ? t('case.onDemand') : c.note.due_date && formatDate(c.note.due_date)}
        missing={missing.has('note_due')}
      />
    </>
  );
}

function EditButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="btn btn-quiet btn-small" onClick={onClick}>
      <Pencil size={15} aria-hidden="true" />
      {label}
    </button>
  );
}

function Events({ c }: { c: LegalCaseDetail }) {
  const { t, formatDate, formatTime } = useI18n();
  return (
    <ol className="case-events">
      {c.events.map((e) => (
        <li key={e.id}>
          <span className="case-event-dot" aria-hidden="true">
            {e.source === 'staff' ? <UserIcon size={13} /> : e.source === 'najiz_filing' ? <Landmark size={13} /> : <CircleDashed size={13} />}
          </span>
          <div>
            <p className="case-event-title">
              {t(`case.event.${e.source}` as MessageKey, { status: t(`case.status.${e.status}` as MessageKey) })}
            </p>
            {e.najiz_status && (
              <p className="case-event-najiz" lang="ar" dir="rtl">
                {e.najiz_status}
              </p>
            )}
            {e.note && <p className="quote-small">{e.note}</p>}
            <p className="muted case-event-meta">
              {formatDate(e.recorded_at)} · {formatTime(e.recorded_at)}
              {e.recorded_by_name ? ` · ${e.recorded_by_name}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------- filing pack

function PackCard({ c, canEdit }: { c: LegalCaseDetail; canEdit: boolean }) {
  const { t, formatDate, formatTime } = useI18n();
  const toast = useToast();
  const source = useSource();
  const make = useMakePack();
  const latest = c.pack ? source.documentUrl(c.pack.id) : null;
  return (
    <section className="panel case-card case-pack">
      <h2 className="panel-title">
        <FileStack size={18} aria-hidden="true" />
        {t('case.pack')}
      </h2>
      <p className="panel-hint">{t('case.packHint')}</p>
      {c.pack && (
        <p className="case-pack-latest">
          {t('case.packLatest', { when: `${formatDate(c.pack.created_at)} ${formatTime(c.pack.created_at)}` })}
          {latest && (
            <a className="btn btn-quiet btn-small" href={latest} download={c.pack.file_name}>
              <Download size={15} aria-hidden="true" />
              {t('case.packDownload')}
            </a>
          )}
        </p>
      )}
      {canEdit && (
        <button
          type="button"
          className="btn btn-quiet btn-block"
          disabled={make.isPending}
          onClick={() =>
            make.mutate(c.row.debt_id, {
              onSuccess: (r) => {
                toast(r.notAttached ? t('case.packMadeMissing', { count: r.notAttached }) : t('case.packMade'));
                if (r.url) window.location.assign(r.url);
              },
              onError: (err) => toast(errorText(err, t), 'error'),
            })
          }
        >
          <FileStack size={17} aria-hidden="true" />
          {make.isPending ? t('case.packMaking') : t(c.pack ? 'case.packAgain' : 'case.packMake')}
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------- approval

function ApproveCard({ c, canEdit }: { c: LegalCaseDetail; canEdit: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const approve = useApproveFiling();
  const [email, setEmail] = useState(c.company.owner_email);
  const [phone, setPhone] = useState(c.company.owner_phone);
  const [pledge, setPledge] = useState(false);
  const [tried, setTried] = useState(false);
  const missing = c.row.missing.length > 0;
  const emailBad = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const phoneBad = !/^\+?[0-9 ]{9,16}$/.test(phone.trim());

  const submit = () => {
    setTried(true);
    if (emailBad || phoneBad || !pledge || missing) return;
    approve.mutate(
      { debtId: c.row.debt_id, input: { contact_email: email.trim(), contact_phone: phone.replace(/\s/g, ''), pledge: true } },
      { onSuccess: () => toast(t('case.approvedToast', { name: c.row.full_name })) },
    );
  };

  return (
    <section className="panel case-card case-approve" aria-labelledby="approve-title">
      <h2 id="approve-title" className="panel-title">
        <ShieldCheck size={18} aria-hidden="true" />
        {t('case.approveTitle')}
      </h2>
      <p className="panel-hint">{t('case.approveHint')}</p>
      {canEdit ? (
        <form
          className="form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field label={t('case.contactEmail')} hint={t('case.contactHint')} error={tried && emailBad ? t('case.emailBad') : undefined}>
            {(p) => <input {...p} type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} disabled={missing} />}
          </Field>
          <Field label={t('case.contactPhone')} error={tried && phoneBad ? t('case.phoneBad') : undefined}>
            {(p) => <input {...p} type="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={missing} />}
          </Field>
          <label className={`check pledge${tried && !pledge ? ' pledge-error' : ''}`}>
            <input type="checkbox" checked={pledge} onChange={(e) => setPledge(e.target.checked)} disabled={missing} />
            <span>{t('case.pledge')}</span>
          </label>
          {tried && !pledge && <p className="field-msg">{t('case.pledgeNeeded')}</p>}
          <FormError message={approve.error ? errorText(approve.error, t) : null} />
          <button type="submit" className="btn btn-primary btn-block" disabled={missing || approve.isPending}>
            {t('case.approve')}
          </button>
          {missing && <p className="muted case-approve-why">{t('case.approveLocked')}</p>}
        </form>
      ) : (
        <p className="muted">{t('case.viewerNote')}</p>
      )}
    </section>
  );
}

// ------------------------------------------------------------- dialogs

function CompanyDialog({ c, onClose }: { c: LegalCaseDetail; onClose: () => void }) {
  const { t } = useI18n();
  const save = useSaveNajizDetails();
  const [type, setType] = useState<'national_id' | 'iqama'>(c.company.owner_id_type ?? 'national_id');
  const [ownerId, setOwnerId] = useState('');
  const [unified, setUnified] = useState(c.company.unified_number ?? '');
  const [tried, setTried] = useState(false);
  const digits = (v: string) => v.replace(/[\s-]/g, '');
  const idBad = !new RegExp(`^${type === 'national_id' ? '1' : '2'}[0-9]{9}$`).test(digits(ownerId));
  const unifiedBad = !/^7[0-9]{9}$/.test(digits(unified));
  const submit = () => {
    setTried(true);
    if (idBad || unifiedBad) return;
    save.mutate(
      { debtId: c.row.debt_id, input: { company: { owner_id_type: type, owner_id_number: digits(ownerId), unified_number: digits(unified) } } },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('case.editCompany')}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>{t('common.save')}</button>
        </>
      }
    >
      <p className="dialog-lead">{t('case.companyLead', { name: c.company.owner_name })}</p>
      <div className="form">
        <Field label={t('case.ownerIdType')}>
          {(p) => (
            <select {...p} value={type} onChange={(e) => setType(e.target.value as 'national_id' | 'iqama')}>
              <option value="national_id">{t('idtype.national_id')}</option>
              <option value="iqama">{t('idtype.iqama')}</option>
            </select>
          )}
        </Field>
        <Field label={t('case.ownerId')} hint={c.company.owner_id_last4 ? t('case.ownerIdNow', { last4: c.company.owner_id_last4 }) : undefined} error={tried && idBad ? t('case.ownerIdBad') : undefined}>
          {(p) => <input {...p} dir="ltr" inputMode="numeric" autoComplete="off" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} />}
        </Field>
        <Field label={t('case.unified')} error={tried && unifiedBad ? t('case.unifiedBad') : undefined}>
          {(p) => <input {...p} dir="ltr" inputMode="numeric" value={unified} onChange={(e) => setUnified(e.target.value)} />}
        </Field>
      </div>
      <FormError message={save.error ? errorText(save.error, t) : null} />
    </Dialog>
  );
}

function NameDialog({ c, onClose }: { c: LegalCaseDetail; onClose: () => void }) {
  const { t } = useI18n();
  const save = useSaveNajizDetails();
  const [v, setV] = useState({ first: c.debtor.first_name ?? '', father: c.debtor.father_name ?? '', grand: c.debtor.grandfather_name ?? '', family: c.debtor.family_name ?? '' });
  const [tried, setTried] = useState(false);
  const bad = { first: !v.first.trim(), family: !v.family.trim() };
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: e.target.value });
  const submit = () => {
    setTried(true);
    if (bad.first || bad.family) return;
    save.mutate(
      { debtId: c.row.debt_id, input: { debtor: { first_name: v.first.trim(), father_name: v.father.trim() || undefined, grandfather_name: v.grand.trim() || undefined, family_name: v.family.trim() } } },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('case.editName')}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>{t('common.save')}</button>
        </>
      }
    >
      <p className="dialog-lead">{t('case.nameLead', { name: c.debtor.full_name })}</p>
      <div className="form form-2">
        <Field label={t('case.firstName')} error={tried && bad.first ? t('common.required') : undefined}>{(p) => <input {...p} dir="auto" value={v.first} onChange={set('first')} />}</Field>
        <Field label={`${t('case.fatherName')} (${t('common.optional')})`}>{(p) => <input {...p} dir="auto" value={v.father} onChange={set('father')} />}</Field>
        <Field label={`${t('case.grandfatherName')} (${t('common.optional')})`}>{(p) => <input {...p} dir="auto" value={v.grand} onChange={set('grand')} />}</Field>
        <Field label={t('case.familyName')} error={tried && bad.family ? t('common.required') : undefined}>{(p) => <input {...p} dir="auto" value={v.family} onChange={set('family')} />}</Field>
      </div>
      <FormError message={save.error ? errorText(save.error, t) : null} />
    </Dialog>
  );
}

function NoteDialog({ c, onClose }: { c: LegalCaseDetail; onClose: () => void }) {
  const { t } = useI18n();
  const save = useSaveNajizDetails();
  const [city, setCity] = useState(c.note.issue_city ?? '');
  const [onDemand, setOnDemand] = useState(c.note.due_on_demand);
  const [due, setDue] = useState(c.note.due_date ?? '');
  const [tried, setTried] = useState(false);
  const cityBad = !city.trim();
  const dueBad = !onDemand && !due;
  const submit = () => {
    setTried(true);
    if (cityBad || dueBad) return;
    save.mutate({ debtId: c.row.debt_id, input: { note: { issue_city: city.trim(), due_on_demand: onDemand, due_date: onDemand ? null : due } } }, { onSuccess: onClose });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('case.editNote')}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>{t('common.save')}</button>
        </>
      }
    >
      <div className="form">
        <Field label={t('case.placeLabel')} hint={t('case.placeHint')} error={tried && cityBad ? t('common.required') : undefined}>
          {(p) => (
            <>
              <input {...p} list="saudi-cities" value={city} onChange={(e) => setCity(e.target.value)} />
              <datalist id="saudi-cities">
                {SAUDI_CITIES.map((x) => <option key={x} value={x} />)}
              </datalist>
            </>
          )}
        </Field>
        <fieldset className="choice">
          <legend>{t('case.dueLabel')}</legend>
          <label className="choice-item">
            <input type="radio" name="due" checked={!onDemand} onChange={() => setOnDemand(false)} />
            <span>{t('case.dueOnDate')}</span>
          </label>
          <label className="choice-item">
            <input type="radio" name="due" checked={onDemand} onChange={() => setOnDemand(true)} />
            <span>{t('case.onDemand')}</span>
          </label>
        </fieldset>
        {!onDemand && (
          <Field label={t('case.dueDate')} error={tried && dueBad ? t('common.required') : undefined}>
            {(p) => <input {...p} type="date" value={due} onChange={(e) => setDue(e.target.value)} className="input-short" />}
          </Field>
        )}
      </div>
      <FormError message={save.error ? errorText(save.error, t) : null} />
    </Dialog>
  );
}

function StatusDialog({ c, onClose }: { c: LegalCaseDetail; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const add = useAddLegalStatus();
  const [status, setStatus] = useState<LegalStatus>(MANUAL_STATUSES.includes(c.row.stage as LegalStatus) ? (c.row.stage as LegalStatus) : 'submitted');
  const [note, setNote] = useState('');
  const [number, setNumber] = useState(c.row.najiz_request_number ?? '');
  const [tried, setTried] = useState(false);
  const numberBad = status !== 'withdrawn' && !/^[0-9]{6,20}$/.test(number.trim());
  const submit = () => {
    setTried(true);
    if (numberBad) return;
    add.mutate(
      { debtId: c.row.debt_id, input: { status, najiz_request_number: number.trim() || undefined, note: note.trim() || undefined } },
      { onSuccess: () => (toast(t('case.statusSaved')), onClose()) },
    );
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('case.addStatus')}
      footer={
        <>
          <button type="button" className="btn btn-quiet" onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={add.isPending} onClick={submit}>{t('common.save')}</button>
        </>
      }
    >
      <p className="dialog-lead">{t('case.statusLead')}</p>
      <div className="form">
        <Field label={t('case.statusLabel')}>
          {(p) => (
            <select {...p} value={status} onChange={(e) => setStatus(e.target.value as LegalStatus)}>
              {MANUAL_STATUSES.map((s) => <option key={s} value={s}>{t(`case.status.${s}` as MessageKey)}</option>)}
            </select>
          )}
        </Field>
        <Field label={t('legal.col.request')} error={tried && numberBad ? t('case.numberBad') : undefined}>
          {(p) => <input {...p} dir="ltr" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} />}
        </Field>
        <Field label={`${t('case.statusNote')} (${t('common.optional')})`}>
          {(p) => <textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
      <FormError message={add.error ? errorText(add.error, t) : null} />
    </Dialog>
  );
}
