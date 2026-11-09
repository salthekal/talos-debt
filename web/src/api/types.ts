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
  kind: 'reply' | 'payment_to_review' | 'dispute' | 'promise_broken' | 'legal_ready' | 'system';
  title: string;
  target_table: string | null;
  target_id: string | null;
  read_at: string | null;
  created_at: string;
  /**
   * The details the text is built from, so it shows in the reader's language.
   * `title` (English, from the server) is only the fallback.
   */
  data?: { name?: string; ref?: string; amount?: string; reminders?: number; summary?: Partial<Record<'sent' | 'replies' | 'promises' | 'payments', number>> };
}

export interface FollowUpRules {
  interval_days: number;
  max_attempts: number;
  auto_send: boolean;
}
