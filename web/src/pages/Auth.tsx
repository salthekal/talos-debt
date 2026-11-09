/**
 * Log in, forgot password, and choose a password (from a reset link or an
 * invitation). Email and password only, as agreed with Sal.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, MailCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSource } from '../api/hooks';
import { ApiError } from '../api/source';
import { LogoMark, LogoWordmark } from '../components/Logo';
import { Field, FormError, errorText } from '../components/ui';
import { useI18n } from '../i18n';

const PASSWORD_MIN = 10;

/** Only paths inside the app are followed after login, never another site. */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  if (next.startsWith('/login') || next.startsWith('/forgot') || next.startsWith('/reset')) return '/';
  return next;
}

function AuthLayout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="auth">
      <aside className="auth-brand" aria-hidden="true">
        <div className="auth-brand-inner">
          <LogoWordmark height={26} />
          <svg className="auth-orbit" viewBox="-120 -120 240 240" role="presentation">
            <circle r="100" className="auth-orbit-track" />
            <circle r="100" className="auth-orbit-fill" pathLength={100} strokeDasharray="68 100" transform="rotate(-90)" />
            <circle cx="0" cy="-100" r="7" className="auth-orbit-dot" />
            <circle cx="86.6" cy="50" r="7" className="auth-orbit-dot" />
            <circle cx="-86.6" cy="50" r="7" className="auth-orbit-dot" />
            <circle r="26" className="auth-orbit-core" />
          </svg>
          <p className="auth-brand-line">{t('login.lead')}</p>
        </div>
      </aside>
      <main className="auth-main" id="main">
        <div className="auth-top">
          <span className="auth-mark">
            <LogoMark size={30} />
          </span>
          <button type="button" className="lang-btn" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} aria-label={t('lang.switchLabel')} lang={lang === 'en' ? 'ar' : 'en'}>
            {t('lang.switch')}
          </button>
        </div>
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}

function PasswordInput({ value, onChange, autoComplete, ...p }: { value: string; onChange: (v: string) => void; autoComplete: string; id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <span className="password">
      <input {...p} type={shown ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} dir="ltr" required />
      <button type="button" className="icon-btn" onClick={() => setShown((s) => !s)} aria-label={t(shown ? 'login.hidePassword' : 'login.showPassword')} aria-pressed={shown}>
        {shown ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </span>
  );
}

// ------------------------------------------------------------------- login

export function LoginPage() {
  const { t } = useI18n();
  const source = useSource();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notice = params.get('reset') === 'done' ? t('reset.done') : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) return setError(t('login.wrong'));
    setBusy(true);
    try {
      await source.login(email.trim(), password);
      qc.clear();
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? t('login.wrong') : errorText(err, t));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="auth-title">{t('login.title')}</h1>
      {notice && (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      )}
      <form className="form" onSubmit={submit} noValidate>
        <Field label={t('login.email')}>
          {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" dir="ltr" required autoFocus />}
        </Field>
        <Field label={t('login.password')}>{(p) => <PasswordInput {...p} value={password} onChange={setPassword} autoComplete="current-password" />}</Field>
        <FormError message={error} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>
          {t('login.submit')}
        </button>
      </form>
      <Link to={`/forgot${email ? `?email=${encodeURIComponent(email)}` : ''}`} className="link auth-alt">
        {t('login.forgot')}
      </Link>
    </AuthLayout>
  );
}

// ---------------------------------------------------------- forgot password

export function ForgotPage() {
  const { t } = useI18n();
  const source = useSource();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError(t('common.required'));
    setBusy(true);
    try {
      await source.forgotPassword(email.trim());
      setSent(email.trim());
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      <h1 className="auth-title">{t('forgot.title')}</h1>
      {sent ? (
        <div className="auth-sent" role="status">
          <MailCheck size={28} aria-hidden="true" />
          <p>{t('forgot.sent', { email: sent })}</p>
        </div>
      ) : (
        <>
          <p className="auth-lead">{t('forgot.lead')}</p>
          <form className="form" onSubmit={submit} noValidate>
            <Field label={t('login.email')} error={error ?? undefined}>
              {(p) => <input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" dir="ltr" required autoFocus />}
            </Field>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>
              {t('forgot.submit')}
            </button>
          </form>
        </>
      )}
      <Link to="/login" className="link auth-alt">
        {t('forgot.back')}
      </Link>
    </AuthLayout>
  );
}

// ------------------------------------------------ choose password (reset or invite)

export function ResetPage() {
  const { t } = useI18n();
  const source = useSource();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [link, setLink] = useState<{ kind: 'reset' | 'invite'; fullName: string; email: string } | 'bad' | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<{ password?: string; confirm?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!token) {
      setLink('bad');
      return;
    }
    source.checkResetLink(token).then(
      (l) => live && setLink(l),
      () => live && setLink('bad'),
    );
    return () => {
      live = false;
    };
  }, [source, token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    if (password.length < PASSWORD_MIN) next.password = t('reset.tooShort');
    else if (password !== confirm) next.confirm = t('reset.noMatch');
    setErrors(next);
    if (Object.keys(next).length || !link || link === 'bad') return;
    setBusy(true);
    try {
      await source.resetPassword(token, password);
      navigate(`/login?reset=done&email=${encodeURIComponent(link.email)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410 || err.code === 'link_expired')) setLink('bad');
      else setErrors({ form: errorText(err, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      {link === null ? (
        <p className="auth-lead" role="status">
          {t('common.loading')}
        </p>
      ) : link === 'bad' ? (
        <>
          <h1 className="auth-title">{t('reset.title')}</h1>
          <p className="form-error" role="alert">
            {t('reset.expired')}
          </p>
          <Link to="/forgot" className="btn btn-primary btn-block">
            {t('reset.newLink')}
          </Link>
        </>
      ) : (
        <>
          <h1 className="auth-title">{link.kind === 'invite' ? t('reset.inviteTitle', { name: link.fullName.split(' ')[0] ?? '' }) : t('reset.title')}</h1>
          <p className="auth-lead">
            {link.kind === 'invite' ? t('reset.inviteLead', { email: link.email }) : t('reset.lead', { email: link.email })}
          </p>
          <form className="form" onSubmit={submit} noValidate>
            {/* Lets password managers save the new password under the right account. */}
            <input type="email" name="username" autoComplete="username" value={link.email} readOnly hidden />
            <Field label={t('reset.password')} hint={t('reset.hint')} error={errors.password}>
              {(p) => <PasswordInput {...p} value={password} onChange={setPassword} autoComplete="new-password" />}
            </Field>
            <Field label={t('reset.confirm')} error={errors.confirm}>
              {(p) => <PasswordInput {...p} value={confirm} onChange={setConfirm} autoComplete="new-password" />}
            </Field>
            <FormError message={errors.form} />
            <button type="submit" className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>
              {t('reset.submit')}
            </button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}
