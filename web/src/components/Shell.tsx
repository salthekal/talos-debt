import { Bell, CheckCheck, FileSpreadsheet, Menu, Moon, Orbit, Search, Settings, Sun, Users, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useApprovals, useMe, useNotifications, useSource, useWaitingReminders } from '../api/hooks';
import { useI18n, type MessageKey } from '../i18n';
import { Initials } from './bits';
import { LogoMark, LogoWordmark } from './Logo';

type Theme = 'light' | 'dark';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const v = localStorage.getItem('talos.theme');
      if (v === 'light' || v === 'dark') return v;
    } catch {
      /* ignore */
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const toggle = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem('talos.theme', next);
      } catch {
        /* ignore */
      }
      return next;
    });
  return [theme, toggle];
}

const NAV: { to: string; key: MessageKey; icon: typeof Orbit; end?: boolean }[] = [
  { to: '/', key: 'nav.overview', icon: Orbit, end: true },
  { to: '/debtors', key: 'nav.debtors', icon: Users },
  { to: '/approvals', key: 'nav.approvals', icon: CheckCheck },
  { to: '/notifications', key: 'nav.notifications', icon: Bell },
  { to: '/import', key: 'nav.import', icon: FileSpreadsheet },
  { to: '/settings', key: 'nav.settings', icon: Settings },
];

export function Shell() {
  const { t, lang, setLang } = useI18n();
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const me = useMe();
  const approvals = useApprovals();
  const waiting = useWaitingReminders();
  const notes = useNotifications();
  const source = useSource();
  const mainRef = useRef<HTMLElement>(null);

  // Close the phone menu when the page changes, and move focus to the new page.
  useEffect(() => {
    setOpen(false);
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo?.(0, 0);
  }, [location.pathname]);

  const toApprove =
    (approvals.data?.payments.length ?? 0) + (approvals.data?.disputes.length ?? 0) + (waiting.data?.reminders.length ?? 0);
  const unread = notes.data?.filter((n) => !n.read_at).length ?? 0;
  const counts: Partial<Record<string, number>> = { '/approvals': toApprove, '/notifications': unread };
  const company = me.data?.client?.trade_name ?? me.data?.client?.legal_name ?? '';

  return (
    <div className={`shell${open ? ' shell-open' : ''}`}>
      <a className="skip" href="#main">
        {t('app.skip')}
      </a>

      <aside className="sidebar" aria-label={t('nav.menu')}>
        <div className="sidebar-head">
          <NavLink to="/" className="brand" aria-label={`${t('app.name')}, ${t('nav.overview')}`}>
            <LogoWordmark height={20} />
          </NavLink>
          <span className="brand-product">{t('app.product')}</span>
          <button type="button" className="icon-btn sidebar-close" onClick={() => setOpen(false)} aria-label={t('nav.close')}>
            <X size={20} />
          </button>
        </div>

        <nav className="nav">
          {NAV.map(({ to, key, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className="nav-link">
              <Icon size={19} strokeWidth={1.75} aria-hidden="true" />
              <span>{t(key)}</span>
              {counts[to] ? <span className="nav-count">{counts[to]}</span> : null}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          {source.demo && <span className="demo-tag">{t('demo.badge')}</span>}
          {me.data && (
            <div className="who" title={t('common.user', { name: me.data.user.fullName })}>
              <Initials name={me.data.user.fullName} />
              <span className="who-text">
                <span className="who-name">{me.data.user.fullName}</span>
                <span className="who-company">{company}</span>
              </span>
            </div>
          )}
        </div>
      </aside>
      <button type="button" className="scrim" aria-hidden="true" tabIndex={-1} onClick={() => setOpen(false)} />

      <div className="frame">
        <header className="topbar">
          <button type="button" className="icon-btn menu-btn" onClick={() => setOpen(true)} aria-label={t('nav.menu')} aria-expanded={open}>
            <Menu size={20} />
          </button>
          <span className="topbar-mark">
            <LogoMark size={26} />
          </span>
          <SearchBox />
          <div className="topbar-actions">
            <button type="button" className="lang-btn" onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} aria-label={t('lang.switchLabel')} lang={lang === 'en' ? 'ar' : 'en'}>
              {t('lang.switch')}
            </button>
            <button type="button" className="icon-btn" onClick={toggleTheme} aria-label={t('theme.toggle')}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <NavLink to="/notifications" className="icon-btn bell" aria-label={`${t('nav.notifications')}${unread ? ` (${unread})` : ''}`}>
              <Bell size={19} />
              {unread > 0 && <span className="bell-dot" aria-hidden="true" />}
            </NavLink>
          </div>
        </header>

        <main id="main" ref={mainRef} tabIndex={-1} className="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SearchBox() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [value, setValue] = useState(params.get('search') ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    navigate(q ? `/debtors?search=${encodeURIComponent(q)}` : '/debtors');
  };
  return (
    <form className="search" role="search" onSubmit={submit}>
      <Search size={17} aria-hidden="true" className="search-icon" />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('search.placeholder')}
        aria-label={t('search.label')}
      />
    </form>
  );
}
