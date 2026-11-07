/**
 * Small wrapper around the Meta WhatsApp Cloud API for sending messages.
 * Kept behind an interface so tests (and later another provider) can swap it.
 */

export interface TemplateMessage {
  phoneNumberId: string; // Meta id of the sending number
  to: string; // +9665XXXXXXXX
  templateName: string;
  languageCode: string; // Meta language code, e.g. "ar", "en", "en_US"
  bodyParams: string[]; // values for {{1}}, {{2}}, ...
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; errorCode: string; errorMessage: string; retryable: boolean };

export interface TextMessage {
  phoneNumberId: string;
  to: string;
  text: string;
}

export interface WhatsAppSender {
  sendTemplate(msg: TemplateMessage): Promise<SendResult>;
  /** Free-form text. Only allowed within 24 hours of the person's last message. */
  sendText(msg: TextMessage): Promise<SendResult>;
}

export class MetaCloudSender implements WhatsAppSender {
  constructor(
    private readonly token: string,
    private readonly apiVersion: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(msg: TextMessage): Promise<SendResult> {
    return this.post(msg.phoneNumberId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.to.replace(/^\+/, ''),
      type: 'text',
      text: { body: msg.text, preview_url: false },
    });
  }

  async sendTemplate(msg: TemplateMessage): Promise<SendResult> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: msg.templateName,
        language: { code: msg.languageCode },
        ...(msg.bodyParams.length
          ? { components: [{ type: 'body', parameters: msg.bodyParams.map((text) => ({ type: 'text', text })) }] }
          : {}),
      },
    };
    return this.post(msg.phoneNumberId, body);
  }

  private async post(phoneNumberId: string, body: unknown): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return { ok: false, errorCode: 'network_error', errorMessage: String(err), retryable: true };
    }

    const json = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[];
      error?: { code?: number; message?: string; error_subcode?: number };
    };
    const id = json.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, providerMessageId: id };

    const code = json.error?.code;
    return {
      ok: false,
      errorCode: code !== undefined ? `meta_${code}` : `http_${res.status}`,
      errorMessage: json.error?.message ?? `HTTP ${res.status}`,
      // Rate limits and server errors can be retried; bad tokens or templates cannot.
      retryable: res.status >= 500 || res.status === 429 || code === 130429 || code === 131056,
    };
  }
}

/** Fill {{1}}, {{2}} ... in a template body, for the copy saved in our messages table. */
export function renderTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, n: string) => params[Number(n) - 1] ?? match);
}
