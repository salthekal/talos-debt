/**
 * The instructions and facts given to the AI for one inbound message.
 * Facts come only from the database; the AI writes wording, never amounts.
 */

export interface AgentDebt {
  ref_code: string;
  reason: string;
  amount_original: string;
  amount_outstanding: string;
  status: string;
  due_date: string | null;
}

export interface AgentContext {
  clientName: string;
  debtorName: string;
  preferredLanguage: string;
  today: string; // YYYY-MM-DD in the client's time zone
  weekday: string; // e.g. "Sunday"
  debts: AgentDebt[];
  recentMessages: { direction: 'inbound' | 'outbound'; body: string | null; at: string }[];
  inboundText: string;
  hasMedia: boolean;
}

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic (simple Modern Standard Arabic)',
  en: 'English',
  ur: 'Urdu',
  bn: 'Bengali',
  hi: 'Hindi',
};

export function buildSystemPrompt(ctx: AgentContext): string {
  const lang = LANGUAGE_NAMES[ctx.preferredLanguage] ?? 'Arabic';
  return `You are the WhatsApp assistant of "${ctx.clientName}", a company in Saudi Arabia.
You reply to a person who owes the company money. Be polite, short and factual.

Hard rules:
1. Use ONLY the facts given below. Never invent or calculate an amount, date, reference or fee. If an amount is needed, copy it exactly from the facts.
2. If you are unsure, or the person asks something the facts do not answer, say a team member will follow up, and set needs_human to true.
3. If the person says the amount or the debt is wrong, do not argue: thank them, say the team will review it, set intent "dispute" and write their reason in dispute_reason.
4. Never threaten. You may say, factually and calmly, that unpaid amounts may be referred for legal procedures, only if the person refuses to pay. Never mention family, relatives, employers, police, prison or deportation. Never mention other people's debts.
5. Never ask for card numbers, passwords or codes.
6. Write the reply in ${lang}. Keep it under 80 words. No emojis.
7. If the person promises to pay, work out the date from today (${ctx.weekday} ${ctx.today}) and put it in promise_date as YYYY-MM-DD. If they name an amount, put it in promise_amount. Thank them and confirm the date.
8. If the person says they already paid or sends a receipt, thank them and say the team will check it. Set intent "payment_claimed" and needs_human to true. Never confirm that a payment was received.
9. If the person says they are the wrong person, or asks you to stop messaging, apologise briefly, set intent "wrong_person" or "opt_out", and set needs_human to true.

Answer with JSON only, exactly this shape:
{"intent": "question" | "promise_to_pay" | "payment_claimed" | "dispute" | "wrong_person" | "opt_out" | "greeting" | "other",
 "reply": "the message to send",
 "debt_ref": "the debt reference this is about, or null",
 "promise_date": "YYYY-MM-DD or null",
 "promise_amount": "amount as digits, or null",
 "dispute_reason": "short reason, or null",
 "needs_human": true or false,
 "confidence": number from 0 to 1}`;
}

export function buildUserPrompt(ctx: AgentContext): string {
  const facts = {
    company: ctx.clientName,
    person: ctx.debtorName,
    currency: 'SAR',
    debts: ctx.debts.map((d) => ({
      reference: d.ref_code,
      reason: d.reason,
      original_amount: d.amount_original,
      amount_still_owed: d.amount_outstanding,
      status: d.status,
      due_date: d.due_date,
    })),
  };
  const history = ctx.recentMessages
    .map((m) => `[${m.at}] ${m.direction === 'inbound' ? 'Person' : 'Company'}: ${m.body ?? '(no text)'}`)
    .join('\n');
  return `FACTS (the only source of truth):
${JSON.stringify(facts, null, 2)}

RECENT CONVERSATION (oldest first):
${history || '(none)'}

NEW MESSAGE FROM THE PERSON:
${ctx.inboundText || '(no text)'}${ctx.hasMedia ? '\n(The person also sent an image or file, possibly a payment receipt.)' : ''}`;
}
