/**
 * What the Najiz worker needs from Najiz, as one small interface (5.4, 5.5).
 *
 * The real one drives a browser (`robot.ts`); tests use the same robot
 * against a fake Najiz, so the worker never knows which one it has.
 *
 * Najiz rules (CLAUDE.md):
 *  - the owner approves every sign-in in Nafath; no password is ever held
 *  - nothing about the session is kept: the browser session lives only in
 *    the worker's memory and `close()` throws it away
 *  - anything unexpected stops the run (`NajizStop`), never a guess
 */

/** Why a run stopped. The same words as `najiz_runs.stop_reason` (migration 0009). */
export type StopReason =
  | 'unexpected_page' | 'captcha' | 'najiz_error' | 'details_differ' | 'company_not_found' | 'cancelled' | 'worker_lost';

/**
 * Najiz showed something the robot did not expect. `detail` is for staff, in
 * plain words, and never holds session data. `afterSend` means "send" was
 * already pressed, so the request may be on Najiz even though no number was read.
 */
export class NajizStop extends Error {
  constructor(
    readonly reason: StopReason,
    readonly detail: string,
    readonly afterSend = false,
  ) {
    super(`${reason}: ${detail}`);
    this.name = 'NajizStop';
  }
}

export interface FileToUpload {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

/** Everything one execution request needs, already checked by the readiness rules. Amounts are text. */
export interface NajizFiling {
  unifiedNumber: string;
  contactEmail: string;
  /** Saudi mobile as Najiz shows it: 05XXXXXXXX. */
  contactPhone: string;
  bankName: string;
  iban: string;
  crFile: FileToUpload;
  contractFile: FileToUpload | null;
  partnersFile: FileToUpload | null;
  debtor: {
    /** ISO country code, for example PK. */
    nationality: string;
    idType: 'national_id' | 'iqama' | 'passport';
    idNumber: string;
    firstName: string;
    fatherName: string | null;
    grandfatherName: string | null;
    familyName: string;
    /** Saudi mobile, 05XXXXXXXX, or null. */
    phone: string | null;
  };
  note: {
    faceAmount: string;
    received: string;
    claimed: string;
    referenceNumber: string | null;
    /** YYYY-MM-DD */
    issueDate: string;
    issueCountry: string;
    issueCity: string;
    dueOnDemand: boolean;
    dueDate: string | null;
    file: FileToUpload;
  };
}

/** The steps of one request, as the dashboard shows them (`najiz_run_items.step`). */
export type FilingStep = 'request_type' | 'requester' | 'debtor' | 'content' | 'sending';

export interface Filed {
  requestNumber: string;
  /** A picture of Najiz's confirmation page, saved as a `najiz_receipt` document. */
  receipt: Buffer;
}

export interface NajizStatus {
  /** The request status as Najiz writes it, for example "قيد التنفيذ". */
  status: string;
  /** The circuit, for example "دائرة التنفيذ الثالثة", when Najiz shows one. */
  circuit: string | null;
}

export interface NajizSite {
  /** Open Najiz Business and ask to sign in with the owner's Nafath. Returns the number Najiz shows. */
  startSignIn(ownerIdNumber: string): Promise<{ nafathNumber: string }>;
  /** True once the owner chose the number in Nafath and Najiz let us in. Does not wait. */
  signedIn(): Promise<boolean>;
  /** Choose the establishment whose unified number is this one. */
  chooseCompany(unifiedNumber: string): Promise<void>;
  /**
   * File one note. `onStep` is told when each step starts. `mayStillSend` is
   * asked just before "send" is pressed; false stops the run (cancelled).
   */
  fileNote(
    filing: NajizFiling,
    hooks: { onStep(step: FilingStep): Promise<void>; mayStillSend(): Promise<boolean> },
  ): Promise<Filed>;
  /** Find a request by its number in the execution list and read its status. */
  checkStatus(requestNumber: string): Promise<NajizStatus>;
  /** Throw the browser session away. Safe to call twice. */
  close(): Promise<void>;
}

/** "4200.50" to riyals "4200" and halalas "50", from the text, never as a number. */
export function splitAmount(amount: string): { riyals: string; halalas: string } {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not an amount: ${amount}`);
  return { riyals: (m[1] ?? '0').replace(/^0+(?=\d)/, ''), halalas: (m[2] ?? '').padEnd(2, '0') };
}

/** +9665XXXXXXXX to 05XXXXXXXX, as Najiz asks for a Saudi mobile. Other numbers stay as they are. */
export function saudiMobile(e164: string): string {
  return e164.startsWith('+9665') ? `0${e164.slice(4)}` : e164;
}
