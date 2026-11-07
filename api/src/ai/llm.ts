/**
 * The AI model behind one small interface, so the provider can be swapped by
 * configuration (CLAUDE.md). Today: Google Gemini. Tests use a fake.
 */

export interface LlmRequest {
  system: string;
  user: string;
}

export interface LlmResponse {
  text: string; // the model's JSON answer, as text
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null; // text, like money elsewhere; "0" on the free tier
}

export interface LlmClient {
  generateJson(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {}

export class GeminiClient implements LlmClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly freeTier: boolean,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async generateJson(req: LlmRequest): Promise<LlmResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1024 },
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new LlmError(`AI request failed: ${String(err)}`);
    }
    const json = (await res.json().catch(() => ({}))) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      error?: { message?: string };
    };
    if (!res.ok) throw new LlmError(`AI error ${res.status}: ${json.error?.message ?? 'unknown'}`);
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text) throw new LlmError('AI returned an empty answer');
    return {
      text,
      model: this.model,
      inputTokens: json.usageMetadata?.promptTokenCount ?? null,
      outputTokens: json.usageMetadata?.candidatesTokenCount ?? null,
      // Paid pricing changes often; record tokens and work out cost from them later.
      costUsd: this.freeTier ? '0' : null,
    };
  }
}
