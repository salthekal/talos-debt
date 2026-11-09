import { MailPlus, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAddUser, useMe, useResendInvite, useRules, useTemplates, useUpdateRules, useUpdateUser, useUsers } from '../api/hooks';
import type { FollowUpRules, Role, Template, User } from '../api/types';
import { Empty, ErrorState, Initials, Loading } from '../components/bits';
import { Dialog, Field, FormError, errorText, useToast } from '../components/ui';
import { useI18n, type MessageKey } from '../i18n';

type Tab = 'rules' | 'team' | 'templates';
const TABS: Tab[] = ['rules', 'team', 'templates'];
const ROLES: Role[] = ['owner', 'admin', 'staff', 'viewer'];
/** Saudi working week first: Sunday to Saturday. */
const DAYS = [0, 1, 2, 3, 4, 5, 6];

export function SettingsPage() {
  const { t } = useI18n();
  const params = useParams();
  const navigate = useNavigate();
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : 'rules';

  const onKey = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const rtl = document.documentElement.dir === 'rtl';
    const next = TABS[(TABS.indexOf(tab) + (rtl ? -step : step) + TABS.length) % TABS.length]!;
    navigate(`/settings/${next}`);
    requestAnimationFrame(() => document.getElementById(`stab-${next}`)?.focus());
  };

  return (
    <div className="page settings">
      <header className="page-head">
        <h1 className="page-title">{t('settings.title')}</h1>
      </header>
      <div className="tabs" role="tablist" aria-label={t('settings.title')} onKeyDown={onKey}>
        {TABS.map((x) => (
          <Link
            key={x}
            id={`stab-${x}`}
            to={`/settings/${x}`}
            role="tab"
            aria-selected={tab === x}
            aria-controls={`spanel-${x}`}
            tabIndex={tab === x ? 0 : -1}
            className="tab"
          >
            {t(`settings.tab.${x}` as MessageKey)}
          </Link>
        ))}
      </div>
      <div role="tabpanel" id={`spanel-${tab}`} aria-labelledby={`stab-${tab}`} className="tab-panel">
        {tab === 'rules' ? <RulesForm /> : tab === 'team' ? <Team /> : <Templates />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ follow-up rules

function RulesForm() {
  const { t } = useI18n();
  const me = useMe();
  const rules = useRules();
  const update = useUpdateRules();
  const toast = useToast();
  const canChange = me.data?.user.role === 'owner' || me.data?.user.role === 'admin';
  const [f, setF] = useState<FollowUpRules | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof FollowUpRules | 'form', string>>>({});

  useEffect(() => {
    if (rules.data && !f) setF(rules.data);
  }, [rules.data, f]);

  if (rules.isError) return <ErrorState onRetry={() => rules.refetch()} />;
  if (!f || !rules.data) return <Loading rows={6} />;
  const original = rules.data;
  const set = <K extends keyof FollowUpRules>(k: K, v: FollowUpRules[K]) => setF({ ...f, [k]: v });
  const changes = (Object.keys(f) as (keyof FollowUpRules)[]).filter((k) => k !== 'timezone' && JSON.stringify(f[k]) !== JSON.stringify(original[k]));

  const num = (k: 'interval_days' | 'max_attempts' | 'legal_after_attempts' | 'promise_grace_days', min: number, max: number) => (
    <Field label={t(`settings.rules.${{ interval_days: 'interval', max_attempts: 'max', legal_after_attempts: 'legal', promise_grace_days: 'grace' }[k]}` as MessageKey)} error={errors[k]}>
      {(p) => (
        <input
          {...p}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={Number.isFinite(f[k]) ? f[k] : ''}
          onChange={(e) => set(k, e.target.value === '' ? NaN : Math.trunc(Number(e.target.value)))}
          disabled={!canChange}
          className="input-short"
        />
      )}
    </Field>
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const range = (k: 'interval_days' | 'max_attempts' | 'legal_after_attempts' | 'promise_grace_days', min: number, max: number) => {
      if (!Number.isInteger(f[k]) || f[k] < min || f[k] > max) next[k] = t('settings.rules.range', { min, max });
    };
    range('interval_days', 1, 30);
    range('max_attempts', 1, 50);
    range('legal_after_attempts', 1, 50);
    range('promise_grace_days', 0, 30);
    if (!next.legal_after_attempts && !next.max_attempts && f.legal_after_attempts > f.max_attempts) next.legal_after_attempts = t('settings.rules.legalTooHigh');
    if (f.working_hours_end <= f.working_hours_start) next.working_hours_end = t('settings.rules.hoursOrder');
    if (!f.working_days.length) next.working_days = t('common.required');
    setErrors(next);
    if (Object.keys(next).length || !changes.length) return;
    const body = Object.fromEntries(changes.map((k) => [k, f[k]])) as Partial<FollowUpRules>;
    update.mutate(body, {
      onSuccess: (saved) => {
        setF(saved);
        toast(t('common.saved'));
      },
      onError: (err) => setErrors({ form: errorText(err, t) }),
    });
  };

  return (
    <form className="panel form settings-form" onSubmit={submit} noValidate>
      <p className="panel-hint">{t('settings.rules.lead')}</p>
      {!canChange && <p className="callout">{t('settings.rules.readOnly')}</p>}

      <fieldset className="form-section">
        <div className="form-row">
          {num('interval_days', 1, 30)}
          {num('max_attempts', 1, 50)}
        </div>
        <div className="form-row">
          {num('legal_after_attempts', 1, 50)}
          {num('promise_grace_days', 0, 30)}
        </div>
      </fieldset>

      <fieldset className="form-section">
        <legend>{t('settings.rules.hours')}</legend>
        <div className="form-row">
          <Field label={t('settings.rules.from')} error={errors.working_hours_start}>
            {(p) => <input {...p} type="time" step={900} value={f.working_hours_start} onChange={(e) => set('working_hours_start', e.target.value.slice(0, 5))} disabled={!canChange} dir="ltr" />}
          </Field>
          <Field label={t('settings.rules.to')} error={errors.working_hours_end}>
            {(p) => <input {...p} type="time" step={900} value={f.working_hours_end} onChange={(e) => set('working_hours_end', e.target.value.slice(0, 5))} disabled={!canChange} dir="ltr" />}
          </Field>
        </div>
        <p className="field-hint">{t('settings.rules.timezone', { tz: t('settings.rules.riyadh') })}</p>
      </fieldset>

      <fieldset className="form-section">
        <legend>{t('settings.rules.days')}</legend>
        <div className="day-picks">
          {DAYS.map((d) => (
            <label key={d} className="day-pick">
              <input
                type="checkbox"
                checked={f.working_days.includes(d)}
                disabled={!canChange}
                onChange={(e) => set('working_days', e.target.checked ? [...f.working_days, d].sort() : f.working_days.filter((x) => x !== d))}
              />
              <span>{t(`day.${d}` as MessageKey)}</span>
            </label>
          ))}
        </div>
        {errors.working_days && <p className="field-msg">{errors.working_days}</p>}
      </fieldset>

      <fieldset className="form-section">
        <label className="switch">
          <input type="checkbox" role="switch" checked={f.auto_send} disabled={!canChange} onChange={(e) => set('auto_send', e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          <span className="switch-text">
            <strong>{t('settings.rules.auto')}</strong>
            <span>{t(f.auto_send ? 'settings.rules.autoOn' : 'settings.rules.autoOff')}</span>
          </span>
        </label>
      </fieldset>

      <FormError message={errors.form} />
      {canChange && (
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" disabled={!changes.length} onClick={() => (setF(original), setErrors({}))}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!changes.length || update.isPending} aria-busy={update.isPending}>
            {t('common.save')}
          </button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------------ team

function Team() {
  const { t, relative } = useI18n();
  const me = useMe();
  const users = useUsers();
  const updateUser = useUpdateUser();
  const resend = useResendInvite();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const myRole = me.data?.user.role;
  const manages = myRole === 'owner' || myRole === 'admin';
  const onError = (err: unknown) => toast(errorText(err, t), 'error');

  if (users.isError) return <ErrorState onRetry={() => users.refetch()} />;
  if (!users.data) return <Loading rows={4} />;

  /** Admins cannot change owners or make someone an owner (the API checks this too). */
  const canTouch = (u: User) => manages && u.id !== me.data?.user.id && (myRole === 'owner' || u.role !== 'owner');
  const rolesFor = myRole === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner');

  return (
    <section className="panel team">
      <div className="panel-head">
        <p className="panel-hint">{t('settings.team.lead')}</p>
        {manages && (
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            <UserPlus size={17} aria-hidden="true" />
            {t('settings.team.add')}
          </button>
        )}
      </div>
      {users.data.length === 0 ? (
        <Empty>{t('settings.team.lead')}</Empty>
      ) : (
        <ul className="people">
          {users.data.map((u) => {
            const you = u.id === me.data?.user.id;
            return (
              <li key={u.id} className={`person${u.is_active ? '' : ' person-off'}`}>
                <Initials name={u.full_name} />
                <span className="person-id">
                  <span className="person-name">
                    {u.full_name}
                    {you && <span className="tag">{t('settings.team.you')}</span>}
                    {!u.is_active && <span className="tag tag-off">{t('settings.team.inactive')}</span>}
                  </span>
                  <span className="person-email" dir="ltr">
                    {u.email}
                  </span>
                  <span className="person-seen">{u.last_login_at ? t('settings.team.lastLogin', { when: relative(u.last_login_at) ?? '' }) : t('settings.team.never')}</span>
                </span>
                <span className="person-role">
                  {canTouch(u) && u.is_active ? (
                    <select
                      aria-label={t('settings.team.roleOf', { name: u.full_name })}
                      value={u.role}
                      disabled={updateUser.isPending}
                      onChange={(e) =>
                        updateUser.mutate({ id: u.id, changes: { role: e.target.value as Role } }, { onSuccess: () => toast(t('common.saved')), onError })
                      }
                    >
                      {(u.role === 'owner' ? ROLES : rolesFor).map((r) => (
                        <option key={r} value={r}>
                          {t(`role.${r}` as MessageKey)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="role-label">{t(`role.${u.role}` as MessageKey)}</span>
                  )}
                </span>
                <span className="person-actions">
                  {canTouch(u) && !u.last_login_at && u.is_active && (
                    <button
                      type="button"
                      className="btn btn-link btn-small"
                      disabled={resend.isPending}
                      onClick={() => resend.mutate(u.id, { onSuccess: () => toast(t('settings.team.invited', { email: u.email })), onError })}
                    >
                      <MailPlus size={15} aria-hidden="true" />
                      {t('settings.team.resend')}
                    </button>
                  )}
                  {canTouch(u) && (
                    <button
                      type="button"
                      className={`btn btn-small ${u.is_active ? 'btn-quiet' : 'btn-link'}`}
                      disabled={updateUser.isPending}
                      onClick={() =>
                        updateUser.mutate({ id: u.id, changes: { is_active: !u.is_active } }, { onSuccess: () => toast(t('common.saved')), onError })
                      }
                    >
                      {t(u.is_active ? 'settings.team.deactivate' : 'settings.team.activate')}
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <AddPerson open={adding} onClose={() => setAdding(false)} roles={rolesFor} />
    </section>
  );
}

function AddPerson({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const { t } = useI18n();
  const add = useAddUser();
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [errors, setErrors] = useState<{ name?: string; email?: string; form?: string }>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (name.trim().length < 2) next.name = t('common.required');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = t('common.required');
    setErrors(next);
    if (Object.keys(next).length) return;
    add.mutate(
      { full_name: name.trim(), email: email.trim(), role },
      {
        onSuccess: () => {
          toast(t('settings.team.invited', { email: email.trim() }));
          setName('');
          setEmail('');
          setRole('staff');
          onClose();
        },
        onError: (err) => setErrors({ form: errorText(err, t) }),
      },
    );
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('settings.team.add')}>
      <form className="form" onSubmit={submit} noValidate>
        <Field label={t('settings.team.name')} error={errors.name}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" dir="auto" required />}
        </Field>
        <Field label={t('settings.team.email')} error={errors.email}>
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" dir="ltr" required />}
        </Field>
        <fieldset className="choice choice-roles">
          <legend>{t('settings.team.role')}</legend>
          {roles.map((r) => (
            <label key={r} className="choice-item">
              <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
              <span>
                <strong>{t(`role.${r}` as MessageKey)}</strong>
                <span className="choice-hint">{t(`role.${r}.hint` as MessageKey)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <FormError message={errors.form} />
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={add.isPending} aria-busy={add.isPending}>
            {t('settings.team.invite')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------- templates

function Templates() {
  const { t } = useI18n();
  const templates = useTemplates();
  if (templates.isError) return <ErrorState onRetry={() => templates.refetch()} />;
  if (!templates.data) return <Loading rows={4} />;
  const byPurpose = new Map<string, Template[]>();
  for (const x of templates.data) byPurpose.set(x.purpose, [...(byPurpose.get(x.purpose) ?? []), x]);

  return (
    <section className="templates">
      <p className="panel-hint">{t('settings.templates.lead')}</p>
      {templates.data.length === 0 ? (
        <div className="panel">
          <Empty>{t('settings.templates.empty')}</Empty>
        </div>
      ) : (
        [...byPurpose].map(([purpose, list]) => (
          <section key={purpose} className="panel template-group">
            <h2 className="panel-title">{t(`template.purpose.${purpose}` as MessageKey)}</h2>
            <ul className="template-list">
              {list.map((x) => (
                <li key={x.id} className="template">
                  <p className="template-head">
                    <span className="tag">{t(`lang.${x.language}` as MessageKey)}</span>
                    <span className={`pill pill-tpl-${x.approval_status}`}>{t(`template.status.${x.approval_status}` as MessageKey)}</span>
                  </p>
                  <p className="template-body" dir="auto" lang={x.language}>
                    {x.body.split(/(\{\{\d+\}\})/).map((part, i) =>
                      /^\{\{\d+\}\}$/.test(part) ? (
                        <span key={i} className="ph" dir="ltr">
                          {part.slice(2, -2)}
                        </span>
                      ) : (
                        part
                      ),
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
