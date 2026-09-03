type FetchImpl = typeof fetch;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionInput {
  messages: ChatMessage[];
  jsonMode?: boolean;
  maxTokens?: number;
}

export type ChatCompletionResult =
  | { status: "success"; content: string }
  | { status: "failed"; raw_error: string };

export interface GroqClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
// Verified against Groq's own current docs, which explicitly recommend this
// as the fastest/cheapest model for exactly this kind of short, low-latency,
// non-reasoning call. Overridable via GROQ_MODEL -- Groq's hosted model
// roster rotates, same hedge as GEMINI_MODEL.
const DEFAULT_MODEL = "openai/gpt-oss-20b";
// Deliberately tight: the buildspec is explicit that this call must not add
// noticeable latency to the purchase flow it rides along with, and a slow
// response here is a signal something's wrong, not a reason to wait longer.
const DEFAULT_TIMEOUT_MS = 5_000;

function normalizeErrorBody(body: unknown, status: number): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error
  ) {
    return String((body.error as { message: unknown }).message);
  }
  return `Groq request failed with status ${status}`;
}

function extractContent(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("choices" in body)) return null;
  const choices = (body as { choices: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = choices[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

export class GroqClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: GroqClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chatCompletion(input: ChatCompletionInput): Promise<ChatCompletionResult> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          ...(input.jsonMode ? { response_format: { type: "json_object" } } : {}),
          ...(input.maxTokens ? { max_completion_tokens: input.maxTokens } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (!response.ok) {
        return { status: "failed", raw_error: normalizeErrorBody(body, response.status) };
      }

      const content = extractContent(body);
      if (content === null) {
        return { status: "failed", raw_error: "Groq response had no choices/message/content" };
      }

      return { status: "success", content };
    } catch (err) {
      return {
        status: "failed",
        raw_error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
