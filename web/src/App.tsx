import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SourceContext } from './api/hooks';
import type { DataSource } from './api/source';
import { Shell } from './components/Shell';
import { I18nProvider, type Lang } from './i18n';
import { ApprovalsPage } from './pages/Approvals';
import { DebtorPage } from './pages/Debtor';
import { DebtorsPage } from './pages/Debtors';
import { NotFound } from './pages/NotFound';
import { OverviewPage } from './pages/Overview';

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<OverviewPage />} />
        <Route path="debtors" element={<DebtorsPage />} />
        <Route path="debtors/:id" element={<DebtorPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="approvals/:tab" element={<ApprovalsPage />} />
        <Route path="overview" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
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
    () => new QueryClient({ defaultOptions: { queries: { retry: initialPath ? false : 1, refetchOnWindowFocus: false } } }),
  );
  const routes = <AppRoutes />;
  return (
    <SourceContext.Provider value={source}>
      <QueryClientProvider client={client}>
        <I18nProvider defaultLang={lang}>
          {initialPath ? (
            <MemoryRouter initialEntries={[initialPath]}>{routes}</MemoryRouter>
          ) : hashRouter ? (
            <HashRouter>{routes}</HashRouter>
          ) : (
            <BrowserRouter>{routes}</BrowserRouter>
          )}
        </I18nProvider>
      </QueryClientProvider>
    </SourceContext.Provider>
  );
}
