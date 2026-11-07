import { z } from 'zod';

/** What the AI must answer for every inbound message. */
export const decisionSchema = z.object({
  intent: z.enum([
    'question', // asks about the debt (amount, reason, how to pay)
    'promise_to_pay', // says when they will pay
    'payment_claimed', // says they already paid or sends a receipt
    'dispute', // says the amount or the debt is wrong
    'wrong_person', // says this is not them / wrong number
    'opt_out', // asks to stop receiving messages
    'greeting', // hello / thanks, nothing else
    'other',
  ]),
  reply: z.string().trim().min(1).max(1000),
  debt_ref: z.string().nullable().default(null), // which debt the message is about
  promise_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  promise_amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .nullable()
    .default(null),
  dispute_reason: z.string().max(500).nullable().default(null),
  needs_human: z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.5),
});

export type Decision = z.infer<typeof decisionSchema>;

/** Safe replies used when the AI's reply fails a check, or the AI is down. */
export const FALLBACK_REPLY: Record<string, string> = {
  ar: 'شكراً لتواصلك. سيتواصل معك أحد أعضاء الفريق قريباً.',
  en: 'Thank you for your message. A member of our team will contact you soon.',
  ur: 'آپ کے پیغام کا شکریہ۔ ہماری ٹیم کا ایک رکن جلد آپ سے رابطہ کرے گا۔',
  bn: 'আপনার বার্তার জন্য ধন্যবাদ। আমাদের দলের একজন সদস্য শীঘ্রই আপনার সাথে যোগাযোগ করবেন।',
  hi: 'आपके संदेश के लिए धन्यवाद। हमारी टीम का एक सदस्य जल्द ही आपसे संपर्क करेगा।',
};

/** Words that suggest a threat or contact with family/employer (rule 4). */
const BANNED = [
  /\bjail\b/i, /\bprison\b/i, /\bpolice\b/i, /\barrest/i, /\bdeport/i, /\bfamily\b/i, /\brelatives?\b/i,
  /\bemployer\b/i, /\bshame\b/i,
  /سجن/, /شرطة/, /القبض/, /ترحيل/, /عائلت/, /أهلك/, /اهلك/, /أقاربك/, /فضيحة/,
];

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Turn Arabic-Indic and Persian digits into 0-9 so numbers can be checked. */
export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => String(ARABIC_INDIC.indexOf(d) >= 0 ? ARABIC_INDIC.indexOf(d) : PERSIAN.indexOf(d)));
}

/** "3450.00" -> "3450", "1280.50" -> "1280.5": compare amounts as text, never as floats. */
export function canonicalAmount(s: string): string {
  const clean = s.replace(/,/g, '').replace(/^0+(?=\d)/, '');
  if (!clean.includes('.')) return clean;
  return clean.replace(/0+$/, '').replace(/\.$/, '');
}

export interface ReplyFacts {
  allowedAmounts: string[]; // amounts from the database (outstanding, original, promised)
  allowedRefs: string[]; // debt and debtor reference codes
  debtorText: string; // what the debtor wrote (they may quote their own numbers)
}

/**
 * Check an AI reply before it is sent (rules 1 and 4).
 * Every amount-like number (3+ digits or with decimals) must come from the
 * database or from the debtor's own message. No threats.
 */
export function checkReply(reply: string, facts: ReplyFacts): { ok: true } | { ok: false; reason: string } {
  if (BANNED.some((re) => re.test(reply))) return { ok: false, reason: 'banned_wording' };

  let text = normalizeDigits(reply);
  for (const ref of facts.allowedRefs) text = text.split(ref).join(' ');
  // Dates and times are not amounts.
  text = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b\d{1,2}[:/]\d{2}\b/g, ' ');

  const allowed = new Set(facts.allowedAmounts.map(canonicalAmount));
  for (const n of normalizeDigits(facts.debtorText).match(/\d[\d,]*(?:\.\d+)?/g) ?? []) allowed.add(canonicalAmount(n));

  for (const raw of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = canonicalAmount(raw);
    const looksLikeAmount = n.includes('.') || n.replace(/\D/g, '').length >= 3;
    if (looksLikeAmount && !allowed.has(n)) return { ok: false, reason: `unknown_amount:${raw}` };
  }
  return { ok: true };
}

/** Parse the AI's JSON answer; undefined if it is not valid. */
export function parseDecision(text: string): Decision | undefined {
  try {
    const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const parsed = decisionSchema.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
