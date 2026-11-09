/**
 * The dialogs behind every action staff take on a debt: send a reminder,
 * pause, record a payment, reject a payment, decide a dispute. Each shows the
 * API's own message when it refuses, and a short confirmation when it works.
 */
import { useState, type FormEvent } from 'react';
import { useMe, usePauseDebt, useRecordPayment, useRejectPayment, useResolveDispute, useSendReminder } from '../api/hooks';
import { ApiError, type PaymentInput } from '../api/source';
import type { DebtRow, DebtStatus, DisputeToReview, PaymentToReview } from '../api/types';
import { useI18n } from '../i18n';
import { groupDigits, toHalalas } from '../lib/money';
import { Dialog, Field, FormError, errorText, useToast } from './ui';

/** Viewers can look but not change anything (the API refuses them too). */
export function useCanEdit() {
  const me = useMe();
  return !!me.data && me.data.user.role !== 'viewer';
}

const DONE: DebtStatus[] = ['paid', 'closed', 'written_off'];
export const canPay = (d: DebtRow) => !DONE.includes(d.status);
export const canPause = (d: DebtRow) => !DONE.includes(d.status) && d.status !== 'paused' && d.status !== 'in_legal';
export const canRemind = (d: DebtRow) => ['open', 'in_follow_up', 'partly_paid', 'promised'].includes(d.status);

/** Riyadh's date today, as YYYY-MM-DD. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
}

/** A typed amount like "1,250.5" becomes "1250.50"; anything else is null. Never a JavaScript number. */
export function cleanAmount(v: string): string | null {
  const s = v.replace(/[,\s٬]/g, '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace('٫', '.');
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const out = `${BigInt(w!).toString()}.${f.padEnd(2, '0')}`;
  return toHalalas(out) > 0n ? out : null;
}

function DebtPicker({ debts, value, onChange }: { debts: DebtRow[]; value: string; onChange: (id: string) => void }) {
  const { t } = useI18n();
  if (debts.length < 2) return null;
  return (
    <Field label={t('action.whichDebt')}>
      {(p) => (
        <select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
          {debts.map((d) => (
            <option key={d.debt_id} value={d.debt_id}>
              {d.ref_code}: SAR {groupDigits(d.amount_outstanding)}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

function Buttons({ busy, submit, onClose, danger }: { busy: boolean; submit: string; onClose: () => void; danger?: boolean }) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" className="btn btn-quiet" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy} aria-busy={busy}>
        {submit}
      </button>
    </>
  );
}

// ------------------------------------------------------------ send reminder

export function SendReminderDialog({ open, onClose, name, debts }: { open: boolean; onClose: () => void; name: string; debts: DebtRow[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const send = useSendReminder();
  const [debtId, setDebtId] = useState(debts[0]?.debt_id ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const debt = debts.find((d) => d.debt_id === debtId) ?? debts[0]!;
    // The first message uses the first-reminder template; later ones the follow-up.
    send.mutate({ debtId: debt.debt_id, purpose: debt.attempts_count === 0 ? 'first_reminder' : 'follow_up' }, {
      onSuccess: () => {
        toast(t('action.sendReminder.done', { name }));
        onClose();
      },
      onError: (err) => setError(errorText(err, t)),
    });
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('action.sendReminder.confirm', { name })}>
      <form onSubmit={submit} className="form">
        <p className="dialog-lead">{t('action.sendReminder.hint')}</p>
        <DebtPicker debts={debts} value={debtId} onChange={setDebtId} />
        <FormError message={error} />
        <div className="form-actions">
          <Buttons busy={send.isPending} submit={t('debtor.sendReminder')} onClose={onClose} />
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------- pause

export function PauseDialog({ open, onClose, debts }: { open: boolean; onClose: () => void; debts: DebtRow[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const pause = usePauseDebt();
  const [debtId, setDebtId] = useState(debts[0]?.debt_id ?? '');
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; until?: string; form?: string }>({});
  const debt = debts.find((d) => d.debt_id === debtId) ?? debts[0];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!debt) return;
    if (reason.trim().length < 3) return setErrors({ reason: t('common.required') });
    if (until && until <= today()) return setErrors({ until: t('action.pause.untilPast') });
    setErrors({});
    pause.mutate(
      { debtId: debt.debt_id, reason: reason.trim(), until: until || undefined },
      {
        onSuccess: () => {
          toast(t('action.pause.done', { ref: debt.ref_code }));
          setReason('');
          setUntil('');
          onClose();
        },
        onError: (err) => setErrors({ form: errorText(err, t) }),
      },
    );
  };
  return (
    <Dialog open={open} onClose={onClose} title={t('action.pause.title', { ref: debt?.ref_code ?? '' })}>
      <form onSubmit={submit} className="form" noValidate>
        <DebtPicker debts={debts} value={debtId} onChange={setDebtId} />
        <Field label={t('action.pause.reason')} error={errors.reason}>
          {(p) => <textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />}
        </Field>
        <Field label={t('action.pause.until')} hint={t('action.pause.untilHint')} error={errors.until}>
          {(p) => <input {...p} type="date" value={until} min={today()} onChange={(e) => setUntil(e.target.value)} />}
        </Field>
        <FormError message={errors.form} />
        <div className="form-actions">
          <Buttons busy={pause.isPending} submit={t('action.pause.submit')} onClose={onClose} />
        </div>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------- record payment

const METHODS: PaymentInput['method'][] = ['bank_transfer', 'cash', 'salary_deduction', 'other'];

export function RecordPaymentDialog({ open, onClose, debts }: { open: boolean; onClose: () => void; debts: DebtRow[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const record = useRecordPayment();
  const [debtId, setDebtId] = useState(debts[0]?.debt_id ?? '');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentInput['method']>('bank_transfer');
  const [paidAt, setPaidAt] = useState(today());
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<{ amount?: string; paid_at?: string; form?: string }>({});
  const debt = debts.find((d) => d.debt_id === debtId) ?? debts[0];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!debt) return;
    const clean = cleanAmount(amount);
    const next: typeof errors = {};
    if (!clean) next.amount = t('common.required');
    else if (toHalalas(clean) > toHalalas(debt.amount_outstanding)) next.amount = t('action.payment.tooMuch', { amount: groupDigits(debt.amount_outstanding, { decimals: true }) });
    if (!paidAt) next.paid_at = t('common.required');
    else if (paidAt > today()) next.paid_at = t('action.payment.future');
    setErrors(next);
    if (Object.keys(next).length) return;
    record.mutate(
      { debtId: debt.debt_id, input: { amount: clean!, method, paid_at: paidAt, note: note.trim() || undefined } },
      {
        onSuccess: () => {
          toast(t('action.payment.done', { amount: groupDigits(clean!, { decimals: true }) }));
          setAmount('');
          setNote('');
          onClose();
        },
        onError: (err) => {
          const f = err instanceof ApiError ? err.fields.find((x) => x.field === 'amount') : undefined;
          setErrors(f ? { amount: f.message } : { form: errorText(err, t) });
        },
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('action.payment.title', { ref: debt?.ref_code ?? '' })}>
      <form onSubmit={submit} className="form" noValidate>
        <DebtPicker debts={debts} value={debtId} onChange={setDebtId} />
        {debt && <p className="dialog-lead">{t('action.payment.hint', { amount: groupDigits(debt.amount_outstanding, { decimals: true }) })}</p>}
        <div className="form-row">
          <Field label={t('action.payment.amount')} error={errors.amount}>
            {(p) => <input {...p} inputMode="decimal" autoComplete="off" dir="ltr" className="input-money" value={amount} onChange={(e) => setAmount(e.target.value)} required />}
          </Field>
          <Field label={t('action.payment.date')} error={errors.paid_at}>
            {(p) => <input {...p} type="date" max={today()} value={paidAt} onChange={(e) => setPaidAt(e.target.value)} required />}
          </Field>
        </div>
        <fieldset className="choice">
          <legend>{t('action.payment.method')}</legend>
          {METHODS.map((m) => (
            <label key={m} className="choice-item">
              <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} />
              <span>{t(`method.${m}`)}</span>
            </label>
          ))}
        </fieldset>
        <Field label={`${t('action.payment.note')} (${t('common.optional')})`}>
          {(p) => <input {...p} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
        </Field>
        <FormError message={errors.form} />
        <div className="form-actions">
          <Buttons busy={record.isPending} submit={t('action.payment.submit')} onClose={onClose} />
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------- reject payment

export function RejectPaymentDialog({ payment, onClose }: { payment: PaymentToReview | null; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const reject = useRejectPayment();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<{ reason?: string; form?: string }>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!payment) return;
    if (reason.trim().length < 3) return setError({ reason: t('common.required') });
    setError({});
    reject.mutate(
      { id: payment.id, reason: reason.trim() },
      {
        onSuccess: () => {
          toast(t('approvals.rejected'));
          setReason('');
          onClose();
        },
        onError: (err) => setError({ form: errorText(err, t) }),
      },
    );
  };
  return (
    <Dialog open={!!payment} onClose={onClose} title={t('approvals.reject.title')}>
      <form onSubmit={submit} className="form" noValidate>
        {payment && (
          <p className="dialog-lead">
            {payment.full_name}, {payment.debt_ref}: SAR {groupDigits(payment.amount, { decimals: true })}
          </p>
        )}
        <Field label={t('approvals.reject.reason')} error={error.reason}>
          {(p) => <textarea {...p} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />}
        </Field>
        <FormError message={error.form} />
        <div className="form-actions">
          <Buttons busy={reject.isPending} submit={t('approvals.reject.submit')} onClose={onClose} danger />
        </div>
      </form>
    </Dialog>
  );
}

// ----------------------------------------------------------- decide dispute

type Verdict = 'amount_correct' | 'debtor_right';
type After = 'correct_amount' | 'close' | 'pause';

export function DisputeDialog({ dispute, verdict, onClose }: { dispute: DisputeToReview | null; verdict: Verdict; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const resolve = useResolveDispute();
  const [note, setNote] = useState('');
  const [after, setAfter] = useState<After>('correct_amount');
  const [corrected, setCorrected] = useState('');
  const [errors, setErrors] = useState<{ note?: string; amount?: string; form?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!dispute) return;
    const next: typeof errors = {};
    if (note.trim().length < 3) next.note = t('common.required');
    const clean = after === 'correct_amount' ? cleanAmount(corrected) : null;
    if (verdict === 'debtor_right' && after === 'correct_amount' && !clean) next.amount = t('common.required');
    setErrors(next);
    if (Object.keys(next).length) return;
    const decision =
      verdict === 'amount_correct'
        ? ({ outcome: 'amount_correct', note: note.trim() } as const)
        : ({ outcome: 'debtor_right', note: note.trim(), action: after, ...(clean ? { corrected_amount: clean } : {}) } as const);
    resolve.mutate(
      { id: dispute.id, decision },
      {
        onSuccess: () => {
          toast(t('approvals.dispute.done'));
          setNote('');
          setCorrected('');
          onClose();
        },
        onError: (err) => setErrors({ form: errorText(err, t) }),
      },
    );
  };

  return (
    <Dialog open={!!dispute} onClose={onClose} title={t('approvals.dispute.title', { ref: dispute?.debt_ref ?? '' })}>
      <form onSubmit={submit} className="form" noValidate>
        <p className="dialog-verdict">
          <strong>{t(verdict === 'debtor_right' ? 'approvals.dispute.resolveValid' : 'approvals.dispute.resolveInvalid')}</strong>
          <span>{t(verdict === 'debtor_right' ? 'approvals.dispute.validHint' : 'approvals.dispute.invalidHint')}</span>
        </p>
        {dispute && (
          <blockquote className="quote-small" dir="auto">
            {dispute.reason}
          </blockquote>
        )}
        <Field label={t('approvals.dispute.note')} error={errors.note}>
          {(p) => <textarea {...p} rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required />}
        </Field>
        {verdict === 'debtor_right' && (
          <fieldset className="choice">
            <legend>{t('approvals.dispute.whatNow')}</legend>
            {(['correct_amount', 'close', 'pause'] as After[]).map((a) => (
              <label key={a} className="choice-item">
                <input type="radio" name="after" value={a} checked={after === a} onChange={() => setAfter(a)} />
                <span>{t(a === 'correct_amount' ? 'approvals.dispute.correct' : a === 'close' ? 'approvals.dispute.close' : 'approvals.dispute.pause')}</span>
              </label>
            ))}
          </fieldset>
        )}
        {verdict === 'debtor_right' && after === 'correct_amount' && (
          <Field label={t('approvals.dispute.correctAmount')} error={errors.amount}>
            {(p) => <input {...p} inputMode="decimal" dir="ltr" className="input-money" value={corrected} onChange={(e) => setCorrected(e.target.value)} />}
          </Field>
        )}
        <FormError message={errors.form} />
        <div className="form-actions">
          <Buttons busy={resolve.isPending} submit={t('approvals.dispute.submit')} onClose={onClose} />
        </div>
      </form>
    </Dialog>
  );
}
