import type {
  ApproveFilingInput, NajizUploadKind, LegalCaseDetail, LegalRow, LegalStatusInput, NajizDetailsInput, NajizRun,
  Approvals, DebtorDetail, DebtPage, DebtStatus, FollowUpRules, ImportReport, Me, NewDebtorInput, Notification, Summary,
  DocType, DocumentInfo, Task, Template, Totals, User, WaitingReminders,
} from './types';

export interface DebtQuery {
  status?: DebtStatus;
  search?: string;
  limit?: number;
  offset?: number;
}

export type DisputeDecision =
  | { outcome: 'amount_correct'; note: string }
  | { outcome: 'debtor_right'; note: string; action: 'correct_amount' | 'close' | 'pause'; corrected_amount?: string };

export interface PaymentInput {
  amount: string;
  method: 'bank_transfer' | 'cash' | 'salary_deduction' | 'other';
  paid_at: string;
  note?: string;
}

/** Everything the screens read and do. Two implementations: the real API, and sample data for design review. */
export interface DataSource {
  readonly demo: boolean;

  // Login (before a user is known)
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  forgotPassword(email: string): Promise<void>;
  checkResetLink(token: string): Promise<{ kind: 'reset' | 'invite'; fullName: string; email: string }>;
  resetPassword(token: string, password: string): Promise<void>;

  // Reading
  me(): Promise<Me>;
  totals(): Promise<Totals>;
  summary(): Promise<Summary>;
  debts(q: DebtQuery): Promise<DebtPage>;
  debtor(id: string): Promise<DebtorDetail>;
  debtTasks(debtId: string): Promise<Task[]>;
  approvals(): Promise<Approvals>;
  waitingReminders(): Promise<WaitingReminders>;
  notifications(): Promise<{ unread: number; items: Notification[] }>;
  rules(): Promise<FollowUpRules>;
  users(): Promise<User[]>;
  templates(): Promise<Template[]>;

  // Actions
  approveReminders(taskIds: string[] | 'all'): Promise<{ approved: number }>;
  approvePayment(id: string): Promise<void>;
  rejectPayment(id: string, reason: string): Promise<void>;
  resolveDispute(id: string, decision: DisputeDecision): Promise<{ debt_status: DebtStatus }>;
  sendReminder(debtId: string, purpose?: 'first_reminder' | 'follow_up' | 'final_notice'): Promise<void>;
  pauseDebt(debtId: string, reason: string, until?: string): Promise<void>;
  resumeDebt(debtId: string): Promise<void>;
  recordPayment(debtId: string, input: PaymentInput): Promise<void>;
  markRead(ids: string[] | 'all'): Promise<void>;
  updateRules(changes: Partial<FollowUpRules>): Promise<FollowUpRules>;
  addUser(input: { full_name: string; email: string; role: User['role'] }): Promise<User>;
  updateUser(id: string, changes: { role?: User['role']; is_active?: boolean }): Promise<User>;
  resendInvite(id: string): Promise<void>;
  addDebtor(input: NewDebtorInput): Promise<{ debtorId: string }>;

  // Documents per debtor and debt
  documents(debtorId: string): Promise<DocumentInfo[]>;
  uploadDocument(input: { debtorId: string; debtId?: string; docType: DocType; file: File }): Promise<DocumentInfo>;
  /** Where the browser downloads a document; null when there is no file to download (sample data). */
  documentUrl(id: string): string | null;

  // Excel import
  importTemplateUrl(): string;
  uploadImport(file: File): Promise<ImportReport>;
  confirmImport(id: string): Promise<ImportReport>;
  cancelImport(id: string): Promise<void>;

  // Legal and Najiz (Phase 5)
  legal(): Promise<LegalRow[]>;
  legalCase(debtId: string): Promise<LegalCaseDetail>;
  saveNajizDetails(debtId: string, input: NajizDetailsInput): Promise<void>;
  approveFiling(debtId: string, input: ApproveFilingInput): Promise<void>;
  /** Starts one Najiz sign-in that files the given approved debts. */
  startNajizRun(debtIds: string[]): Promise<NajizRun>;
  najizRun(id: string): Promise<NajizRun>;
  cancelNajizRun(id: string): Promise<void>;
  /** Upload a PDF Najiz needs: the company's papers, or the copy of this debt's note. */
  uploadLegalFile(debtId: string, kind: NajizUploadKind, file: File): Promise<void>;
  /** A status entered by hand (5.3), for example from a Najiz text message. */
  addLegalStatus(debtId: string, input: LegalStatusInput): Promise<void>;
  /** Make the filing pack PDF (5.1). Returns where to download it, or null for sample data. */
  makePack(debtId: string): Promise<{ url: string | null; notAttached: number }>;
  /** The promissory note template, a Word file with no letterhead (5.0b). */
  noteTemplateUrl(): string;
}

/** An error from the API, with the message to show and, for forms, the fields that failed. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: { field: string; message: string }[] = [],
  ) {
    super(message);
  }
}
