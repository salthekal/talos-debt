/**
 * The real API. Same address as the dashboard (Vite forwards /api in
 * development; in production both are served from one domain), so the
 * session cookie is sent with every request. Every request that changes
 * something carries `x-talos: 1`, which the API requires (cross-site
 * request forgery protection).
 */
import { ApiError, type DataSource, type DebtQuery } from './source';
import noteTemplate from '../assets/promissory-note-template.docx?url';
import type { DocumentInfo, ImportReport, LegalCaseDetail, LegalRow, NajizRun } from './types';

/** Called when the session ends (401), so the app can show the login page. */
let onSessionEnded: () => void = () => undefined;
export function setSessionEndedHandler(fn: () => void) {
  onSessionEnded = fn;
}

async function request<T>(method: string, url: string, body?: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (method !== 'GET') headers['x-talos'] = '1';
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'No connection. Check your internet and try again.');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) onSessionEnded();
    const fields = Array.isArray(data.errors) ? (data.errors as { field: string; message: string }[]) : [];
    throw new ApiError(res.status, String(data.error ?? 'error'), String(data.message ?? fields[0]?.message ?? 'Something went wrong'), fields);
  }
  return data as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const httpSource: DataSource = {
  demo: false,

  login: async (email, password) => {
    await request('POST', '/api/auth/login', { email, password }, { auth: false });
  },
  logout: async () => {
    await request('POST', '/api/auth/logout', undefined, { auth: false });
  },
  forgotPassword: async (email) => {
    await request('POST', '/api/auth/forgot', { email }, { auth: false });
  },
  checkResetLink: (token) => request('GET', `/api/auth/reset${qs({ token })}`, undefined, { auth: false }),
  resetPassword: async (token, password) => {
    await request('POST', '/api/auth/reset', { token, password }, { auth: false });
  },

  me: () => request('GET', '/api/me'),
  totals: () => request('GET', '/api/dashboard/totals'),
  summary: () => request('GET', '/api/dashboard/summary'),
  debts: (q: DebtQuery) => request('GET', `/api/debts${qs({ status: q.status, search: q.search, limit: q.limit, offset: q.offset })}`),
  debtor: (id) => request('GET', `/api/debtors/${id}`),
  debtTasks: async (debtId) => (await request<{ tasks: never[] }>('GET', `/api/debts/${debtId}/tasks`)).tasks,
  approvals: () => request('GET', '/api/approvals'),
  waitingReminders: () => request('GET', '/api/reminders/waiting'),
  notifications: () => request('GET', '/api/notifications'),
  rules: () => request('GET', '/api/settings/rules'),
  users: async () => (await request<{ items: never[] }>('GET', '/api/users')).items,
  templates: async () => (await request<{ items: never[] }>('GET', '/api/templates')).items,

  approveReminders: (ids) => request('POST', '/api/reminders/approve', ids === 'all' ? { all: true } : { task_ids: ids }),
  approvePayment: async (id) => {
    await request('POST', `/api/payments/${id}/approve`, {});
  },
  rejectPayment: async (id, reason) => {
    await request('POST', `/api/payments/${id}/reject`, { reason });
  },
  resolveDispute: (id, decision) => request('POST', `/api/disputes/${id}/resolve`, decision),
  sendReminder: async (debtId, purpose) => {
    await request('POST', `/api/debts/${debtId}/send-reminder`, purpose ? { purpose } : {});
  },
  pauseDebt: async (debtId, reason, until) => {
    await request('POST', `/api/debts/${debtId}/pause`, until ? { reason, until } : { reason });
  },
  resumeDebt: async (debtId) => {
    await request('POST', `/api/debts/${debtId}/resume`, {});
  },
  recordPayment: async (debtId, input) => {
    await request('POST', `/api/debts/${debtId}/payments`, input);
  },
  markRead: async (ids) => {
    await request('POST', '/api/notifications/read', ids === 'all' ? { all: true } : { ids });
  },
  updateRules: (changes) => request('PATCH', '/api/settings/rules', changes),
  addUser: (input) => request('POST', '/api/users', input),
  updateUser: (id, changes) => request('PATCH', `/api/users/${id}`, changes),
  resendInvite: async (id) => {
    await request('POST', `/api/users/${id}/invite`, {});
  },
  addDebtor: async (input) => {
    const res = await request<{ debtor: { id: string } }>('POST', '/api/debtors', input);
    return { debtorId: res.debtor.id };
  },

  documents: async (debtorId) => (await request<{ items: DocumentInfo[] }>('GET', `/api/documents${qs({ debtor_id: debtorId })}`)).items,
  uploadDocument: async ({ debtorId, debtId, docType, file }) => {
    // The fields come before the file (the API reads them first).
    const form = new FormData();
    form.append('doc_type', docType);
    if (debtId) form.append('debt_id', debtId);
    else form.append('debtor_id', debtorId);
    form.append('file', file, file.name);
    return (await request<{ document: DocumentInfo }>('POST', '/api/documents', form)).document;
  },
  documentUrl: (id) => `/api/documents/${id}/download`,

  importTemplateUrl: () => '/api/imports/template',
  uploadImport: async (file) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return (await request<{ import: ImportReport }>('POST', '/api/imports', form)).import;
  },
  confirmImport: async (id) => {
    const res = await request<{ import?: ImportReport } & ImportReport>('POST', `/api/imports/${id}/confirm`, {});
    return res.import ?? res;
  },
  cancelImport: async (id) => {
    await request('POST', `/api/imports/${id}/cancel`, {});
  },

  // Legal and Najiz (Phase 5).
  legal: async () => (await request<{ items: LegalRow[] }>('GET', '/api/legal')).items,
  legalCase: (debtId) => request<LegalCaseDetail>('GET', `/api/legal/${debtId}`),
  saveNajizDetails: async (debtId, input) => {
    await request('PATCH', `/api/legal/${debtId}/details`, input);
  },
  approveFiling: async (debtId, input) => {
    await request('POST', `/api/legal/${debtId}/approve`, input);
  },
  startNajizRun: async (debtIds, opts) =>
    (await request<{ run: NajizRun }>('POST', '/api/najiz/runs', { debt_ids: debtIds, ...(opts?.checkedNotOnNajiz ? { checked_not_on_najiz: true } : {}) })).run,
  najizRun: async (id) => (await request<{ run: NajizRun }>('GET', `/api/najiz/runs/${id}`)).run,
  cancelNajizRun: async (id) => {
    await request('POST', `/api/najiz/runs/${id}/cancel`, {});
  },
  uploadLegalFile: async (debtId, kind, file) => {
    const form = new FormData();
    form.append('doc_type', kind);
    // The company's papers belong to the client, not to one debtor.
    if (kind === 'promissory_note') form.append('debt_id', debtId);
    form.append('file', file, file.name);
    await request('POST', '/api/documents', form);
  },
  addLegalStatus: async (debtId, input) => {
    await request('POST', `/api/legal/${debtId}/status`, input);
  },
  makePack: async (debtId) => {
    const res = await request<{ document: DocumentInfo; not_attached: string[] }>('POST', `/api/legal/${debtId}/pack`, {});
    return { url: `/api/documents/${res.document.id}/download`, notAttached: res.not_attached.length };
  },
  noteTemplateUrl: () => noteTemplate,
};
