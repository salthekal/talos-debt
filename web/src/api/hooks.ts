import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { DataSource, DebtQuery, DisputeDecision, PaymentInput } from './source';
import type { ApproveFilingInput, NajizUploadKind, DocType, FollowUpRules, LegalStatusInput, NajizDetailsInput, NewDebtorInput, User } from './types';

export const SourceContext = createContext<DataSource | null>(null);

export function useSource(): DataSource {
  const s = useContext(SourceContext);
  if (!s) throw new Error('useSource outside SourceContext');
  return s;
}

// ------------------------------------------------------------------ reading

export const useMe = () => {
  const s = useSource();
  return useQuery({ queryKey: ['me'], queryFn: () => s.me(), staleTime: 5 * 60_000, retry: false });
};
export const useTotals = () => {
  const s = useSource();
  return useQuery({ queryKey: ['totals'], queryFn: () => s.totals() });
};
export const useSummary = () => {
  const s = useSource();
  return useQuery({ queryKey: ['summary'], queryFn: () => s.summary() });
};
export const useDebts = (q: DebtQuery) => {
  const s = useSource();
  return useQuery({ queryKey: ['debts', q], queryFn: () => s.debts(q), placeholderData: (prev) => prev });
};
export const useDebtor = (id: string) => {
  const s = useSource();
  return useQuery({ queryKey: ['debtor', id], queryFn: () => s.debtor(id) });
};
export const useApprovals = () => {
  const s = useSource();
  return useQuery({ queryKey: ['approvals'], queryFn: () => s.approvals(), refetchInterval: 60_000 });
};
export const useWaitingReminders = () => {
  const s = useSource();
  return useQuery({ queryKey: ['waitingReminders'], queryFn: () => s.waitingReminders(), refetchInterval: 60_000 });
};
export const useNotifications = () => {
  const s = useSource();
  return useQuery({ queryKey: ['notifications'], queryFn: () => s.notifications(), refetchInterval: 60_000 });
};
export const useRules = () => {
  const s = useSource();
  return useQuery({ queryKey: ['rules'], queryFn: () => s.rules(), staleTime: 5 * 60_000 });
};
export const useUsers = () => {
  const s = useSource();
  return useQuery({ queryKey: ['users'], queryFn: () => s.users() });
};
export const useDocuments = (debtorId: string) => {
  const s = useSource();
  return useQuery({ queryKey: ['documents', debtorId], queryFn: () => s.documents(debtorId) });
};
export const useTemplates = () => {
  const s = useSource();
  return useQuery({ queryKey: ['templates'], queryFn: () => s.templates(), staleTime: 5 * 60_000 });
};

export const useLegal = () => {
  const s = useSource();
  return useQuery({ queryKey: ['legal'], queryFn: () => s.legal() });
};
export const useLegalCase = (debtId: string) => {
  const s = useSource();
  return useQuery({ queryKey: ['legalCase', debtId], queryFn: () => s.legalCase(debtId), retry: false });
};
/** A Najiz sign-in in progress: read again every 1.5 seconds until it is finished. */
export const useNajizRun = (id: string | null) => {
  const s = useSource();
  return useQuery({
    queryKey: ['najizRun', id],
    queryFn: () => s.najizRun(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && ['done', 'stopped', 'expired'].includes(q.state.data.stage) ? false : 1500),
  });
};

// ------------------------------------------------------------------ actions

/** After anything that changes a debt, the numbers and lists that show it are fetched again. */
const DEBT_VIEWS = ['totals', 'summary', 'debts', 'debtor', 'approvals', 'waitingReminders', 'notifications', 'legal', 'legalCase'];

function useAction<A, R>(fn: (s: DataSource, a: A) => Promise<R>, refresh: string[] = DEBT_VIEWS) {
  const s = useSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: A) => fn(s, a),
    onSuccess: () => Promise.all(refresh.map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}

export const useApproveReminders = () => useAction((s, ids: string[] | 'all') => s.approveReminders(ids));
export const useApprovePayment = () => useAction((s, id: string) => s.approvePayment(id));
export const useRejectPayment = () => useAction((s, a: { id: string; reason: string }) => s.rejectPayment(a.id, a.reason));
export const useResolveDispute = () => useAction((s, a: { id: string; decision: DisputeDecision }) => s.resolveDispute(a.id, a.decision));
export const useSendReminder = () =>
  useAction((s, a: { debtId: string; purpose?: 'first_reminder' | 'follow_up' | 'final_notice' }) => s.sendReminder(a.debtId, a.purpose));
export const usePauseDebt = () => useAction((s, a: { debtId: string; reason: string; until?: string }) => s.pauseDebt(a.debtId, a.reason, a.until));
export const useResumeDebt = () => useAction((s, debtId: string) => s.resumeDebt(debtId));
export const useRecordPayment = () => useAction((s, a: { debtId: string; input: PaymentInput }) => s.recordPayment(a.debtId, a.input));
export const useMarkRead = () => useAction((s, ids: string[] | 'all') => s.markRead(ids), ['notifications']);
export const useUpdateRules = () => useAction((s, c: Partial<FollowUpRules>) => s.updateRules(c), ['rules', 'waitingReminders']);
export const useAddUser = () => useAction((s, u: { full_name: string; email: string; role: User['role'] }) => s.addUser(u), ['users']);
export const useUpdateUser = () => useAction((s, a: { id: string; changes: { role?: User['role']; is_active?: boolean } }) => s.updateUser(a.id, a.changes), ['users']);
export const useResendInvite = () => useAction((s, id: string) => s.resendInvite(id), []);
export const useAddDebtor = () => useAction((s, d: NewDebtorInput) => s.addDebtor(d));
export const useUploadDocument = () =>
  useAction((s, a: { debtorId: string; debtId?: string; docType: DocType; file: File }) => s.uploadDocument(a), ['documents']);
export const useConfirmImport = () => useAction((s, id: string) => s.confirmImport(id));
const LEGAL_VIEWS = ['legal', 'legalCase', 'debts', 'debtor', 'summary', 'totals'];
export const useSaveNajizDetails = () => useAction((s, a: { debtId: string; input: NajizDetailsInput }) => s.saveNajizDetails(a.debtId, a.input), LEGAL_VIEWS);
export const useApproveFiling = () => useAction((s, a: { debtId: string; input: ApproveFilingInput }) => s.approveFiling(a.debtId, a.input), LEGAL_VIEWS);
export const useStartNajizRun = () =>
  useAction((s, a: { debtIds: string[]; checkedNotOnNajiz?: boolean }) => s.startNajizRun(a.debtIds, { checkedNotOnNajiz: a.checkedNotOnNajiz }), LEGAL_VIEWS);
export const useStartNajizCheck = () => useAction((s, _: void) => s.startNajizCheck(), LEGAL_VIEWS);
export const useCancelNajizRun = () => useAction((s, id: string) => s.cancelNajizRun(id), [...LEGAL_VIEWS, 'najizRun']);
export const useUploadLegalFile = () =>
  useAction((s, a: { debtId: string; kind: NajizUploadKind; file: File }) => s.uploadLegalFile(a.debtId, a.kind, a.file), [...LEGAL_VIEWS, 'documents']);
export const useMakePack = () => useAction((s, debtId: string) => s.makePack(debtId), ['legalCase', 'documents']);
export const useAddLegalStatus = () => useAction((s, a: { debtId: string; input: LegalStatusInput }) => s.addLegalStatus(a.debtId, a.input), LEGAL_VIEWS);
