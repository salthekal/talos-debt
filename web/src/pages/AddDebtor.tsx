import { Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAddDebtor } from '../api/hooks';
import { ApiError } from '../api/source';
import type { Language, NewDebtorInput } from '../api/types';
import { cleanAmount } from '../components/actions';
import { Dialog, Field, FormError, errorText, useToast } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

const ID_TYPES = ['iqama', 'national_id', 'passport', 'cr'] as const;
const LANGS: Language[] = ['ar', 'en', 'ur', 'bn', 'hi'];
const INSTRUMENTS = [
  'none', 'nafith_promissory_note', 'paper_promissory_note', 'cheque', 'bill_of_exchange',
  'court_judgment', 'labor_judgment', 'notarized_contract', 'ejar_lease',
] as const;

type Errors = Partial<Record<'full_name' | 'full_name_ar' | 'id' | 'phones' | 'amount' | 'reason' | 'due' | 'instrument' | 'form', string>>;

/** Which input an API error belongs to ("debts[0].amount" goes under the amount). */
function fieldOf(path: string): keyof Errors {
  if (/instrument/.test(path)) return 'instrument';
  if (/phone/.test(path)) return 'phones';
  if (/amount/.test(path)) return 'amount';
  if (/reason/.test(path)) return 'reason';
  if (/due_date/.test(path)) return 'due';
  if (/id_(number|type)/.test(path)) return 'id';
  if (path === 'full_name_ar') return 'full_name_ar';
  if (path === 'full_name') return 'full_name';
  return 'form';
}

const empty = () => ({
  full_name: '',
  full_name_ar: '',
  id_type: 'iqama' as (typeof ID_TYPES)[number],
  id_number: '',
  language: 'ar' as Language,
  phones: [''],
  amount: '',
  reason: '',
  due: '',
  instrument: 'none' as (typeof INSTRUMENTS)[number],
  instrumentRef: '',
});

export function AddDebtorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const add = useAddDebtor();
  const [f, setF] = useState(empty);
  const [errors, setErrors] = useState<Errors>({});
  const set = <K extends keyof ReturnType<typeof empty>>(k: K, v: ReturnType<typeof empty>[K]) => setF((x) => ({ ...x, [k]: v }));

  const close = () => {
    setErrors({});
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    const amount = cleanAmount(f.amount);
    const phones = f.phones.map((p) => p.trim()).filter(Boolean);
    if (f.full_name.trim().length < 2) next.full_name = t('common.required');
    if (!f.id_number.trim()) next.id = t('common.required');
    if (!phones.length) next.phones = t('common.required');
    if (!amount) next.amount = t('common.required');
    if (f.reason.trim().length < 3) next.reason = t('common.required');
    if (f.instrument !== 'none' && !f.instrumentRef.trim() && f.instrument !== 'court_judgment' && f.instrument !== 'labor_judgment') next.instrument = t('common.required');
    setErrors(next);
    if (Object.keys(next).length) return;

    const input: NewDebtorInput = {
      full_name: f.full_name.trim(),
      ...(f.full_name_ar.trim() ? { full_name_ar: f.full_name_ar.trim() } : {}),
      id_type: f.id_type,
      id_number: f.id_number.trim(),
      preferred_language: f.language,
      phones,
      debts: [
        {
          amount: amount!,
          reason: f.reason.trim(),
          ...(f.due ? { due_date: f.due } : {}),
          ...(f.instrument !== 'none' ? { instrument: { type: f.instrument, ...(f.instrumentRef.trim() ? { reference_number: f.instrumentRef.trim() } : {}) } } : {}),
        },
      ],
    };
    add.mutate(input, {
      onSuccess: ({ debtorId }) => {
        toast(t('add.done', { name: input.full_name }));
        setF(empty());
        close();
        navigate(`/debtors/${debtorId}`);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.fields.length) {
          const out: Errors = {};
          for (const x of err.fields) out[fieldOf(x.field)] ??= x.message;
          setErrors(out);
        } else setErrors({ form: errorText(err, t) });
      },
    });
  };

  return (
    <Dialog open={open} onClose={close} title={t('add.title')} wide>
      <form onSubmit={submit} className="form" noValidate>
        <fieldset className="form-section">
          <legend>{t('add.person')}</legend>
          <div className="form-row">
            <Field label={t('add.fullName')} error={errors.full_name}>
              {(p) => <input {...p} value={f.full_name} onChange={(e) => set('full_name', e.target.value)} autoComplete="off" dir="auto" required />}
            </Field>
            <Field label={`${t('add.fullNameAr')} (${t('common.optional')})`} error={errors.full_name_ar}>
              {(p) => <input {...p} value={f.full_name_ar} onChange={(e) => set('full_name_ar', e.target.value)} autoComplete="off" lang="ar" dir="rtl" />}
            </Field>
          </div>
          <div className="form-row">
            <Field label={t('add.idType')}>
              {(p) => (
                <select {...p} value={f.id_type} onChange={(e) => set('id_type', e.target.value as (typeof ID_TYPES)[number])}>
                  {ID_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {t(`idtype.${x}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('add.idNumber')} error={errors.id}>
              {(p) => <input {...p} value={f.id_number} onChange={(e) => set('id_number', e.target.value)} inputMode={f.id_type === 'passport' ? 'text' : 'numeric'} dir="ltr" autoComplete="off" required />}
            </Field>
            <Field label={t('add.language')}>
              {(p) => (
                <select {...p} value={f.language} onChange={(e) => set('language', e.target.value as Language)}>
                  {LANGS.map((x) => (
                    <option key={x} value={x}>
                      {t(`lang.${x}` as MessageKey)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <div className="phones-edit">
            {f.phones.map((ph, i) => (
              <div key={i} className="phone-edit">
                <Field label={i === 0 ? t('add.phones') : `${t('add.phones')} ${i + 1}`} hint={i === 0 ? t('add.phoneHint') : undefined} error={i === 0 ? errors.phones : undefined}>
                  {(p) => (
                    <input
                      {...p}
                      type="tel"
                      dir="ltr"
                      autoComplete="off"
                      value={ph}
                      onChange={(e) => set('phones', f.phones.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                  )}
                </Field>
                {i > 0 && (
                  <button type="button" className="icon-btn" aria-label={t('add.removePhone')} onClick={() => set('phones', f.phones.filter((_, j) => j !== i))}>
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            ))}
            {f.phones.length < 4 && (
              <button type="button" className="btn btn-link" onClick={() => set('phones', [...f.phones, ''])}>
                <Plus size={16} aria-hidden="true" />
                {t('add.addPhone')}
              </button>
            )}
          </div>
        </fieldset>

        <fieldset className="form-section">
          <legend>{t('add.debt')}</legend>
          <div className="form-row">
            <Field label={t('add.amount')} error={errors.amount}>
              {(p) => <input {...p} inputMode="decimal" dir="ltr" className="input-money" value={f.amount} onChange={(e) => set('amount', e.target.value)} autoComplete="off" required />}
            </Field>
            <Field label={`${t('add.dueDate')} (${t('common.optional')})`} error={errors.due}>
              {(p) => <input {...p} type="date" value={f.due} onChange={(e) => set('due', e.target.value)} />}
            </Field>
          </div>
          <Field label={t('add.reason')} hint={t('add.reasonHint')} error={errors.reason}>
            {(p) => <input {...p} value={f.reason} onChange={(e) => set('reason', e.target.value)} dir="auto" maxLength={300} required />}
          </Field>
          <div className="form-row">
            <Field label={t('add.document')}>
              {(p) => (
                <select {...p} value={f.instrument} onChange={(e) => set('instrument', e.target.value as (typeof INSTRUMENTS)[number])}>
                  {INSTRUMENTS.map((x) => (
                    <option key={x} value={x}>
                      {t(`instrument.${x}` as MessageKey)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {f.instrument !== 'none' && (
              <Field label={t('add.documentRef')} error={errors.instrument}>
                {(p) => <input {...p} value={f.instrumentRef} onChange={(e) => set('instrumentRef', e.target.value)} dir="ltr" autoComplete="off" />}
              </Field>
            )}
          </div>
        </fieldset>

        <FormError message={errors.form} />
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending} aria-busy={add.isPending}>
            {t('add.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
