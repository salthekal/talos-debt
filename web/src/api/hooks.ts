import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { DataSource, DebtQuery } from './source';

export const SourceContext = createContext<DataSource | null>(null);

export function useSource(): DataSource {
  const s = useContext(SourceContext);
  if (!s) throw new Error('useSource outside SourceContext');
  return s;
}

export const useMe = () => {
  const s = useSource();
  return useQuery({ queryKey: ['me'], queryFn: () => s.me(), staleTime: 5 * 60_000 });
};
export const useTotals = () => {
  const s = useSource();
  return useQuery({ queryKey: ['totals'], queryFn: () => s.totals() });
};
export const useDebts = (q: DebtQuery) => {
  const s = useSource();
  return useQuery({ queryKey: ['debts', q], queryFn: () => s.debts(q), placeholderData: (prev) => prev });
};
export const useStatusCounts = () => {
  const s = useSource();
  return useQuery({ queryKey: ['statusCounts'], queryFn: () => s.statusCounts() });
};
export const useDebtor = (id: string) => {
  const s = useSource();
  return useQuery({ queryKey: ['debtor', id], queryFn: () => s.debtor(id) });
};
export const useApprovals = () => {
  const s = useSource();
  return useQuery({ queryKey: ['approvals'], queryFn: () => s.approvals() });
};
export const useWaitingReminders = () => {
  const s = useSource();
  return useQuery({ queryKey: ['waitingReminders'], queryFn: () => s.waitingReminders() });
};
export const useNotifications = () => {
  const s = useSource();
  return useQuery({ queryKey: ['notifications'], queryFn: () => s.notifications() });
};
export const useRules = () => {
  const s = useSource();
  return useQuery({ queryKey: ['rules'], queryFn: () => s.rules(), staleTime: 5 * 60_000 });
};

export const useApproveReminders = () => {
  const s = useSource();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[] | 'all') => s.approveReminders(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['waitingReminders'] }),
  });
};
