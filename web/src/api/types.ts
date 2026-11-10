/** Shapes returned by the API (api/src/routes). Amounts are text, never numbers. */

export type Money = string;

export type DebtStatus =
  | 'open' | 'in_follow_up' | 'promised' | 'partly_paid' | 'paid' | 'disputed'
  | 'paused' | 'legal_ready' | 'in_legal' | 'written_off' | 'closed';

export const DEBT_STATUSES: DebtStatus[] = [
  'open', 'in_follow_up', 'promised', 'partly_paid', 'paid', 'disputed',
  'paused', 'legal_ready', 'in_legal', 'written_off', 'closed',
];

export type Role = 'owner' | 'admin' | 'staff' | 'viewer';
export type Language = 'ar' | 'en' | 'ur' | 'bn' | 'hi';

export interface Me {
  user: { id: string; fullName: string; role: Role };
  client: { id: string; legal_name: string; trade_name: string | null; sector: string | null; plan: string | null; status: string } | null;
}

export interface Totals {
  total_owed: Money;
  recovered: Money;
  promised: Money;
  disputed: Money;
  in_legal: Money;
  open_balance: Money;
  enforceable_share_pct: string | null;
  paper_notes_at_risk: number | string;
}

export interface DebtRow {
  client_id: string;
  debt_id: string;
  ref_code: string;
  debtor_id: string;
  full_name: string;
  amount_original: Money;
  amount_outstanding: Money;
  status: DebtStatus;
  attempts_count: number;
  last_contact_at: string | null;
  last_reply_at: string | null;
  instrument_type: string;
  directly_enforceable: boolean;
  enforceable_until: string | null;
}

export interface DebtPage {
  total: number;
  limit: number;
  offset: number;
  items: DebtRow[];
}

export interface Phone {
  id: string;
  phone_e164: string;
  label: string | null;
  is_primary: boolean;
  has_whatsapp: boolean | null;
  status: 'active' | 'wrong_number' | 'unreachable' | 'opted_out';
}

export interface Debtor {
  id: string;
  ref_code: string;
  debtor_kind: string;
  id_type: string;
  id_number: string;
  full_name: string;
  full_name_ar: string | null;
  nationality: string | null;
  preferred_language: Language;
  employment_status: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}

export type TimelineEvent =
  | { kind: 'message'; id: string; debt_id: string | null; at: string;
      data: { direction: 'inbound' | 'outbound'; channel: string; body: string; status: string; ai_generated: boolean } }
  | { kind: 'payment'; id: string; debt_id: string; at: string;
      data: { amount: Money; method: string; status: 'pending_approval' | 'approved' | 'rejected'; rejection_reason: string | null } }
  | { kind: 'promise'; id: string; debt_id: string; at: string;
      data: { promised_amount: Money | null; promised_date: string; status: 'pending' | 'kept' | 'partly_kept' | 'broken' | 'cancelled' } }
  | { kind: 'dispute'; id: string; debt_id: string; at: string;
      data: { reason: string; status: 'open' | 'resolved_valid' | 'resolved_invalid'; resolution_note: string | null } };

export interface DebtorDetail {
  debtor: Debtor;
  phones: Phone[];
  debts: DebtRow[];
  timeline: TimelineEvent[];
}

export interface PaymentToReview {
  id: string;
  amount: Money;
  method: string;
  paid_at: string | null;
  extracted_details: { bank?: string; reference?: string; date?: string } | null;
  ai_match_confidence: string | null;
  proof_document_id: string | null;
  created_at: string;
  debt_id: string;
  debt_ref: string;
  amount_outstanding: Money;
  debtor_id: string;
  full_name: string;
}

export interface DisputeToReview {
  id: string;
  reason: string;
  created_at: string;
  debt_id: string;
  debt_ref: string;
  amount_outstanding: Money;
  debtor_id: string;
  full_name: string;
}

export interface Approvals {
  payments: PaymentToReview[];
  disputes: DisputeToReview[];
}

export interface WaitingReminder {
  task_id: string;
  due_at: string;
  attempt_number: number | null;
  debt_id: string;
  ref_code: string;
  amount_outstanding: Money;
  debt_status: DebtStatus;
  debtor_id: string;
  full_name: string;
  preferred_language: Language;
}

export interface WaitingReminders {
  auto_send: boolean;
  reminders: WaitingReminder[];
}

export interface Notification {
  id: string;
  kind: 'reply' | 'payment_to_review' | 'dispute' | 'promise_broken' | 'legal_ready' | 'import_done' | 'system';
  title: string;
  target_table: string | null;
  target_id: string | null;
  read_at: string | null;
  created_at: string;
  /**
   * The details the text is built from, so it shows in the reader's language.
   * `title` (English, from the server) is only the fallback.
   */
  data?: NotificationData | null;
}

/** The facts a notification is built from (API: app.notifications.data, migration 0007). */
export interface NotificationData {
  event?:
    | 'receipt' | 'dispute' | 'needs_reply' | 'reply_held' | 'legal_ready' | 'replied_after_last'
    | 'promise_broken' | 'promise_partly' | 'not_sent' | 'send_failed' | 'maybe_not_sent' | 'summary';
  name?: string;
  ref?: string | null;
  amount?: string;
  reminders?: number;
  date?: string;
  debtor_id?: string;
  summary?: Partial<Record<'reminders_sent' | 'replies' | 'promises' | 'payments_to_review' | 'disputes' | 'legal_ready' | 'waiting_approval', number>>;
}

export interface FollowUpRules {
  interval_days: number;
  max_attempts: number;
  legal_after_attempts: number;
  promise_grace_days: number;
  working_hours_start: string;
  working_hours_end: string;
  working_days: number[];
  auto_send: boolean;
  timezone: string;
}

export interface Summary {
  reminders_sent: number;
  promises_open: number;
  legal: number;
  statuses: Partial<Record<DebtStatus, { count: number; outstanding: Money }>>;
}

export interface User {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface Template {
  id: string;
  purpose: string;
  language: Language;
  meta_template_name: string;
  approval_status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'paused';
  body: string;
  shared: boolean;
}

export type DocType =
  | 'national_id' | 'iqama' | 'employment_contract' | 'promissory_note' | 'cheque' | 'judgment'
  | 'contract' | 'invoice' | 'receipt' | 'payment_proof' | 'other';

/** A stored file (api/src/routes/documents.ts). Documents are evidence, so they cannot be deleted. */
export interface DocumentInfo {
  id: string;
  debtor_id: string | null;
  debt_id: string | null;
  doc_type: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | string;
  source: string;
  created_at: string;
}

export interface Task {
  id: string;
  task_type: 'send_reminder' | 'promise_check' | 'call' | 'mark_legal_ready';
  attempt_number: number | null;
  due_at: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';
  skip_reason: string | null;
  approved_at: string | null;
}

export interface ImportIssue {
  row: number | null;
  column: string | null;
  cell: string | null;
  message: string;
}

export interface ImportReport {
  id: string;
  status: 'validating' | 'ready' | 'failed' | 'confirmed' | 'cancelled';
  file_name: string;
  rows_total: number | null;
  rows_ok: number | null;
  rows_failed: number | null;
  summary: {
    rows: number; rows_with_errors: number; debtors_new: number; debtors_existing: number; debts: number;
    total_amount: Money; enforceable_amount: Money; instruments_new: number; instruments_reused: number; phones_new: number;
  } | null;
  errors: ImportIssue[] | null;
  warnings: ImportIssue[] | null;
  created_at: string;
}

export interface NewDebtorInput {
  full_name: string;
  full_name_ar?: string;
  id_type?: 'national_id' | 'iqama' | 'passport' | 'cr';
  id_number: string;
  nationality?: string;
  preferred_language: Language;
  phones: string[];
  debts: { amount: string; reason: string; due_date?: string; instrument?: { type: string; reference_number?: string } }[];
}

// --------------------------------------------- legal and Najiz (Phase 5)

/** A legal case status in the database (`app.legal_cases.status`). */
export type LegalStatus =
  | 'ready' | 'approved' | 'submitted' | 'order_issued' | 'measures_applied' | 'settled' | 'closed' | 'withdrawn';

/**
 * Where a debt stands on its way to Najiz, as the Legal page shows it:
 * details missing, ready for the client to approve, approved and waiting
 * to be filed, being filed now, then the case status after filing.
 */
export type LegalStage =
  | 'missing' | 'to_approve' | 'approved' | 'filing'
  | 'submitted' | 'order_issued' | 'measures_applied' | 'settled' | 'closed' | 'withdrawn';

/** One thing Najiz asks for (docs/najiz-filing.md). */
export type NajizField =
  | 'owner_id' | 'unified_number' | 'iban' | 'cr_file' | 'contract_file'
  | 'debtor_name' | 'debtor_id' | 'debtor_nationality'
  | 'note_type' | 'note_file' | 'note_place' | 'note_date' | 'note_due';

export interface LegalRow {
  debt_id: string;
  debtor_id: string;
  full_name: string;
  ref_code: string;
  amount_outstanding: Money;
  instrument_type: string;
  case_id: string | null;
  stage: LegalStage;
  /** What Najiz needs that is still missing; empty when complete. */
  missing: NajizField[];
  najiz_request_number: string | null;
  najiz_status: string | null;
  najiz_circuit: string | null;
  submitted_at: string | null;
  najiz_status_checked_at: string | null;
  legal_ready_at: string;
}

export interface LegalEvent {
  id: string;
  status: LegalStatus;
  /** As Najiz shows it, when it was read from Najiz. */
  najiz_status: string | null;
  note: string | null;
  source: 'staff' | 'najiz_filing' | 'najiz_check';
  recorded_by_name: string | null;
  recorded_at: string;
}

export type NajizFileKind = 'cr' | 'establishment_contract' | 'partners_decision' | 'promissory_note';
/** Files the client can upload from the case page (the API does not take partners' decisions yet). */
export type NajizUploadKind = 'cr' | 'establishment_contract' | 'promissory_note';

/** Everything Najiz will receive for one debt, and what is missing. */
export interface LegalCaseDetail {
  row: LegalRow;
  company: {
    legal_name: string;
    unified_number: string | null;
    owner_name: string;
    owner_id_type: 'national_id' | 'iqama' | null;
    /** Only the last four digits are ever sent to the browser. */
    owner_id_last4: string | null;
    owner_email: string;
    owner_phone: string;
    bank_name: string | null;
    iban: string | null;
  };
  debtor: {
    full_name: string;
    id_type: string;
    id_number: string;
    nationality: string | null;
    first_name: string | null;
    father_name: string | null;
    grandfather_name: string | null;
    family_name: string | null;
    phone: string | null;
  };
  note: {
    type: string;
    reference_number: string | null;
    issue_date: string | null;
    due_date: string | null;
    due_on_demand: boolean;
    issue_country: string | null;
    issue_city: string | null;
    face_amount: Money | null;
  };
  /** What is claimed (the remaining amount) and what was already received. */
  amounts: { claimed: Money; received: Money };
  files: Record<NajizFileKind, DocumentInfo | null>;
  approval: { approved_by_name: string; approved_at: string; contact_email: string; contact_phone: string } | null;
  events: LegalEvent[];
}

/** Details the client can fill in from the case page. */
export interface NajizDetailsInput {
  company?: { owner_id_type: 'national_id' | 'iqama'; owner_id_number: string; unified_number: string };
  debtor?: { first_name: string; father_name?: string; grandfather_name?: string; family_name: string };
  note?: { issue_city: string; due_on_demand: boolean; due_date?: string | null };
}

export interface ApproveFilingInput {
  contact_email: string;
  contact_phone: string;
  /** The client agrees to the same pledge Najiz asks for. */
  pledge: true;
}

export type NajizRunStage = 'starting' | 'waiting_nafath' | 'filing' | 'done' | 'stopped' | 'expired';
export type NajizCaseStep = 'waiting' | 'request_type' | 'requester' | 'debtor' | 'content' | 'sending' | 'sent' | 'stopped';

/** One sign-in to Najiz that files one or more approved notes. */
export interface NajizRun {
  id: string;
  stage: NajizRunStage;
  /** The two-digit number the owner chooses in the Nafath app. */
  nafath_number: string | null;
  nafath_expires_at: string | null;
  owner_phone_last4: string;
  started_at: string;
  cases: {
    debt_id: string;
    full_name: string;
    ref_code: string;
    amount: Money;
    step: NajizCaseStep;
    request_number: string | null;
  }[];
  /** Why the robot stopped, in plain words, when stage is 'stopped'. */
  stop_reason: 'unexpected_page' | 'captcha' | 'najiz_error' | 'details_differ' | 'cancelled' | null;
}

export interface LegalStatusInput {
  status: LegalStatus;
  najiz_request_number?: string;
  note?: string;
}
