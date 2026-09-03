type FetchImpl = typeof fetch;

export interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateContentInput {
  contents: GeminiContent[];
  tools?: { functionDeclarations: FunctionDeclaration[] }[];
  systemInstruction?: { parts: { text: string }[] };
}

export interface FunctionCallResult {
  name: string;
  args: Record<string, unknown>;
}

export type GenerateContentResult =
  | { status: "success"; text: string | null; functionCalls: FunctionCallResult[] }
  | { status: "failed"; raw_error: string };

export interface GeminiClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// Verified against Google's own current REST API docs for `generateContent`.
// The model name is deliberately overridable (GEMINI_MODEL env var, see
// scripts/run-buyer-agent.ts) rather than hardcoded elsewhere -- Gemini's
// available model ids rotate, and the wrong string here should be a clear,
// fixable runtime error, not a silent assumption baked into the client.
const DEFAULT_MODEL = "gemini-2.5-flash";
// Model calls are slower than a payment API call; a purchase decision in the
// buyer-agent loop can involve real reasoning, not just a fixed lookup.
const DEFAULT_TIMEOUT_MS = 20_000;

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
  return `Gemini request failed with status ${status}`;
}

function extractParts(body: unknown): GeminiPart[] | null {
  if (!body || typeof body !== "object" || !("candidates" in body)) return null;
  const candidates = (body as { candidates: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const first = candidates[0];
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return null;
  return parts as GeminiPart[];
}

export class GeminiClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: GeminiClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateContent(input: GenerateContentInput): Promise<GenerateContentResult> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models/${this.model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Header, not a `?key=` query param -- never let this land in a
          // logged URL.
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify({
          contents: input.contents,
          tools: input.tools,
          systemInstruction: input.systemInstruction,
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

      const parts = extractParts(body);
      if (parts === null) {
        return { status: "failed", raw_error: "Gemini response had no candidates/parts" };
      }

      const functionCalls = parts
        .filter((part): part is GeminiPart & { functionCall: FunctionCallResult } => !!part.functionCall)
        .map((part) => part.functionCall);
      const textParts = parts.filter((part) => typeof part.text === "string").map((part) => part.text as string);

      return {
        status: "success",
        text: textParts.length > 0 ? textParts.join("") : null,
        functionCalls,
      };
    } catch (err) {
      return {
        status: "failed",
        raw_error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
