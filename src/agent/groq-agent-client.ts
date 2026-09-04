import { FunctionCallResult, GenerateContentInput, GenerateContentResult } from "./gemini-client";

type FetchImpl = typeof fetch;

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export interface GroqAgentClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
// Verified against Groq's own current /v1/models list and confirmed with a
// live tool-calling request (llama-3.3-70b-versatile, this project's first
// choice, no longer exists on the hosted roster). qwen/qwen3.6-27b returns
// clean tool_calls without the reasoning-heavy hidden-token overhead of the
// openai/gpt-oss models used elsewhere in this project for Program 6 -- a
// better fit for a fast multi-turn agent loop. Overridable via
// GROQ_AGENT_MODEL -- same hedge as GROQ_MODEL, since Groq's hosted model
// roster rotates.
const DEFAULT_MODEL = "qwen/qwen3.6-27b";
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
  return `Groq request failed with status ${status}`;
}

// loop.ts speaks Gemini's contents/parts/functionCall/functionResponse shape
// (the ContentGenerator interface it depends on was already provider-agnostic
// by design -- see gateway/service.ts's UpsellTrigger for the same pattern).
// This translates that shape into OpenAI-compatible chat messages one-for-one
// on every call, re-deriving synthetic tool_call ids by walking the
// conversation in order each time -- stateless, but consistent, because the
// full history is replayed fresh on every turn and functionCall/
// functionResponse parts always appear in matching order (loop.ts builds the
// response turn by iterating response.functionCalls in the same order it
// received them).
function toOpenAiMessages(input: GenerateContentInput): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (input.systemInstruction) {
    const text = input.systemInstruction.parts.map((p) => p.text).join("");
    messages.push({ role: "system", content: text });
  }

  let callIdCounter = 0;
  let pendingCallIds: string[] = [];

  for (const content of input.contents) {
    if (content.role === "user") {
      const responseParts = content.parts.filter((p) => p.functionResponse);
      for (const part of responseParts) {
        const id = pendingCallIds.shift() ?? `call_${++callIdCounter}`;
        messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(part.functionResponse!.response) });
      }
      const textParts = content.parts.filter((p) => typeof p.text === "string").map((p) => p.text as string);
      if (textParts.length > 0 || responseParts.length === 0) {
        messages.push({ role: "user", content: textParts.join("") });
      }
    } else {
      const textParts = content.parts.filter((p) => typeof p.text === "string").map((p) => p.text as string);
      const callParts = content.parts.filter((p) => p.functionCall);
      const toolCalls: OpenAiToolCall[] = callParts.map((p) => {
        const id = `call_${++callIdCounter}`;
        pendingCallIds.push(id);
        return {
          id,
          type: "function",
          function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args) },
        };
      });
      messages.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
    }
  }

  return messages;
}

function toOpenAiTools(tools: GenerateContentInput["tools"]): Record<string, unknown>[] | undefined {
  const declarations = (tools ?? []).flatMap((t) => t.functionDeclarations);
  if (declarations.length === 0) return undefined;
  return declarations.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters },
  }));
}

export class GroqAgentClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

  constructor(opts: GroqAgentClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async generateContent(input: GenerateContentInput): Promise<GenerateContentResult> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: toOpenAiMessages(input),
          ...(toOpenAiTools(input.tools) ? { tools: toOpenAiTools(input.tools) } : {}),
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

      if (!body || typeof body !== "object" || !("choices" in body)) {
        return { status: "failed", raw_error: "Groq response had no choices/message" };
      }
      const choices = (body as { choices: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        return { status: "failed", raw_error: "Groq response had no choices/message" };
      }
      const message = choices[0]?.message as
        | { content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] }
        | undefined;
      if (!message) {
        return { status: "failed", raw_error: "Groq response had no choices/message" };
      }

      let functionCalls: FunctionCallResult[] = [];
      if (Array.isArray(message.tool_calls)) {
        try {
          functionCalls = message.tool_calls.map((tc) => ({
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
          }));
        } catch (err) {
          return {
            status: "failed",
            raw_error: `Groq returned unparseable tool_call arguments: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      return {
        status: "success",
        text: typeof message.content === "string" ? message.content : null,
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
