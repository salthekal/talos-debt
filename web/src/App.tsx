import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { SourceContext, useMe } from './api/hooks';
import { setSessionEndedHandler } from './api/http';
import { ApiError, type DataSource } from './api/source';
import { Loading } from './components/bits';
import { Shell } from './components/Shell';
import { ToastProvider } from './components/ui';
import { I18nProvider, type Lang } from './i18n';
import { ApprovalsPage } from './pages/Approvals';
import { ForgotPage, LoginPage, ResetPage } from './pages/Auth';
import { DebtorPage } from './pages/Debtor';
import { DebtorsPage } from './pages/Debtors';
import { ImportPage } from './pages/Import';
import { LegalPage } from './pages/Legal';
import { LegalCasePage } from './pages/LegalCase';
import { NotFound } from './pages/NotFound';
import { NotificationsPage } from './pages/Notifications';
import { OverviewPage } from './pages/Overview';
import { SettingsPage } from './pages/Settings';

/** The login page, keeping the page someone was on so they come back to it. */
function toLogin(path: string) {
  return path === '/' ? '/login' : `/login?next=${encodeURIComponent(path)}`;
}

/** Pages behind login: without a session, go to the login page. */
function RequireLogin({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isError) {
    const e = me.error;
    if (e instanceof ApiError && e.status === 401) return <Navigate to={toLogin(location.pathname + location.search)} replace />;
  }
  if (!me.data) {
    return (
      <div className="boot" role="status">
        <Loading rows={3} />
      </div>
    );
  }
  return <>{children}</>;
}

/** When the API says the session ended (expired, logged out elsewhere), clear everything and log in again. */
function SessionWatcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  useEffect(() => {
    setSessionEndedHandler(() => {
      if (/^\/(login|forgot|reset)/.test(window.location.pathname)) return;
      qc.clear();
      navigate(toLogin(location.pathname + location.search), { replace: true });
    });
    return () => setSessionEndedHandler(() => undefined);
  }, [navigate, location, qc]);
  return null;
}

export function AppRoutes() {
  return (
    <>
      <SessionWatcher />
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route path="forgot" element={<ForgotPage />} />
        {/* The emails link to /reset-password (api/src/login); /reset is kept as a short form. */}
        <Route path="reset-password" element={<ResetPage />} />
        <Route path="reset" element={<ResetPage />} />
        <Route
          element={
            <RequireLogin>
              <Shell />
            </RequireLogin>
          }
        >
          <Route index element={<OverviewPage />} />
          <Route path="debtors" element={<DebtorsPage />} />
          <Route path="debtors/:id" element={<DebtorPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="approvals/:tab" element={<ApprovalsPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="legal" element={<LegalPage />} />
          <Route path="legal/:tab" element={<LegalPage />} />
          <Route path="legal/case/:debtId" element={<LegalCasePage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:tab" element={<SettingsPage />} />
          <Route path="overview" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}

export function App({
  source,
  lang,
  initialPath,
  hashRouter,
}: {
  source: DataSource;
  lang?: Lang;
  /** Tests start at a path in memory instead of the browser address. */
  initialPath?: string;
  /** The single-file prototype uses #/paths, so it works from any address. */
  hashRouter?: boolean;
}) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A refused request (no session, no access, not found) is not tried again.
            retry: (count, err) => !initialPath && count < 1 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const routes = <AppRoutes />;
  return (
    <SourceContext.Provider value={source}>
      <QueryClientProvider client={client}>
        <I18nProvider defaultLang={lang}>
          <ToastProvider>
            {initialPath ? (
              <MemoryRouter initialEntries={[initialPath]}>{routes}</MemoryRouter>
            ) : hashRouter ? (
              <HashRouter>{routes}</HashRouter>
            ) : (
              <BrowserRouter>{routes}</BrowserRouter>
            )}
          </ToastProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SourceContext.Provider>
  );
}
