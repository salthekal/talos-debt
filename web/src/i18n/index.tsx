import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ar } from './ar';
import { en, type MessageKey, type Messages } from './en';

export type Lang = 'en' | 'ar';
const dictionaries: Record<Lang, Messages> = { en, ar };
const STORAGE_KEY = 'talos.lang';
/** Clients work in Saudi time; dates are always shown in Asia/Riyadh. */
export const TIME_ZONE = 'Asia/Riyadh';

type Vars = Record<string, string | number>;

export interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Vars) => string;
  /** Gregorian calendar and Western digits in both languages (as Saudi business software uses). */
  locale: string;
  formatDate: (iso: string | Date, opts?: Intl.DateTimeFormatOptions) => string;
  formatTime: (iso: string | Date) => string;
  /** "just now", "3 hours ago", "yesterday", "12 Nov" */
  relative: (iso: string | Date | null | undefined, now?: Date) => string | null;
}

function readStored(): Lang | undefined {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' || v === 'ar' ? v : undefined;
  } catch {
    return undefined;
  }
}

function initialLang(fallback: Lang): Lang {
  return readStored() ?? fallback;
}

export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translate(lang: Lang, key: MessageKey, vars?: Vars): string {
  const entry = dictionaries[lang][key] ?? en[key];
  if (typeof entry === 'string') return interpolate(entry, vars);
  const count = Number(vars?.count ?? 0);
  const category = new Intl.PluralRules(lang === 'ar' ? 'ar' : 'en').select(count);
  return interpolate(entry[category] ?? entry.other, vars);
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, defaultLang = 'en' }: { children: ReactNode; defaultLang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initialLang(defaultLang));

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: the choice lasts for this visit only */
    }
  }, []);

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const value = useMemo<I18n>(() => {
    const locale = lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB';
    const dateFmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, ...opts });
    const formatDate = (iso: string | Date, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
      dateFmt(opts).format(typeof iso === 'string' ? new Date(iso) : iso);
    const formatTime = (iso: string | Date) =>
      dateFmt({ hour: 'numeric', minute: '2-digit' }).format(typeof iso === 'string' ? new Date(iso) : iso);
    const t = (key: MessageKey, vars?: Vars) => translate(lang, key, vars);
    const dayKey = (d: Date) => dateFmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

    const relative: I18n['relative'] = (iso, now = new Date()) => {
      if (!iso) return null;
      const d = typeof iso === 'string' ? new Date(iso) : iso;
      const diff = (now.getTime() - d.getTime()) / 1000;
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      if (Math.abs(diff) < 60) return t('time.now');
      if (diff > 0 && diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
      if (diff > 0 && diff < 6 * 3600) return rtf.format(-Math.round(diff / 3600), 'hour');
      if (dayKey(d) === dayKey(now)) return t('time.today', { time: formatTime(d) });
      const tomorrow = new Date(now.getTime() + 86_400_000);
      if (dayKey(d) === dayKey(tomorrow)) return t('time.tomorrow', { time: formatTime(d) });
      const yesterday = new Date(now.getTime() - 86_400_000);
      if (dayKey(d) === dayKey(yesterday)) return t('time.yesterday');
      if (diff > 0 && diff < 7 * 86400) return rtf.format(-Math.round(diff / 86400), 'day');
      const sameYear = dateFmt({ year: 'numeric' }).format(d) === dateFmt({ year: 'numeric' }).format(now);
      return formatDate(d, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
    };

    return { lang, dir, setLang, t, locale, formatDate, formatTime, relative };
  }, [lang, dir, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

export type { MessageKey };
