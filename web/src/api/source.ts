import type {
  Approvals, DebtorDetail, DebtPage, DebtStatus, FollowUpRules, Me, Notification, Totals, WaitingReminders,
} from './types';

export interface DebtQuery {
  status?: DebtStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Everything the screens read. Two implementations: the real API, and sample data for design review. */
export interface DataSource {
  readonly demo: boolean;
  me(): Promise<Me>;
  totals(): Promise<Totals>;
  debts(q: DebtQuery): Promise<DebtPage>;
  statusCounts(): Promise<Partial<Record<DebtStatus, number>>>;
  debtor(id: string): Promise<DebtorDetail>;
  approvals(): Promise<Approvals>;
  waitingReminders(): Promise<WaitingReminders>;
  notifications(): Promise<Notification[]>;
  rules(): Promise<FollowUpRules>;
  approveReminders(taskIds: string[] | 'all'): Promise<{ approved: number }>;
  approvePayment(id: string): Promise<void>;
  rejectPayment(id: string, reason: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
