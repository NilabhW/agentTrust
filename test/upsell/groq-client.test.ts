import { describe, expect, it, vi } from "vitest";
import { GroqClient } from "../../src/upsell/groq-client";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function chatCompletionBody(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] };
}

const basicInput = { messages: [{ role: "user" as const, content: "hello" }] };

describe("GroqClient.chatCompletion", () => {
  it("returns the message content on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody('{"item_id":"gro-eggs-30"}')));
    const client = new GroqClient({ apiKey: "test-key", fetchImpl });

    const result = await client.chatCompletion(basicInput);

    expect(result).toEqual({ status: "success", content: '{"item_id":"gro-eggs-30"}' });
  });

  it("sends the API key via a Bearer Authorization header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody("ok")));
    const client = new GroqClient({ apiKey: "secret-groq-key", fetchImpl });

    await client.chatCompletion(basicInput);

    const [, requestInit] = fetchImpl.mock.calls[0];
    expect(requestInit.headers.Authorization).toBe("Bearer secret-groq-key");
  });

  it("sends messages and the model, and includes response_format json_object when jsonMode is requested", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody("ok")));
    const client = new GroqClient({ apiKey: "test-key", model: "groq-test-model", fetchImpl });

    await client.chatCompletion({ ...basicInput, jsonMode: true });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.model).toBe("groq-test-model");
    expect(sentBody.messages).toEqual(basicInput.messages);
    expect(sentBody.response_format).toEqual({ type: "json_object" });
  });

  it("sends max_completion_tokens when maxTokens is provided, to bound response size defensively", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody("ok")));
    const client = new GroqClient({ apiKey: "test-key", fetchImpl });

    await client.chatCompletion({ ...basicInput, maxTokens: 150 });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.max_completion_tokens).toBe(150);
  });

  it("omits max_completion_tokens when maxTokens is not provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody("ok")));
    const client = new GroqClient({ apiKey: "test-key", fetchImpl });

    await client.chatCompletion(basicInput);

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.max_completion_tokens).toBeUndefined();
  });

  it("omits response_format when jsonMode is not requested", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatCompletionBody("ok")));
    const client = new GroqClient({ apiKey: "test-key", fetchImpl });

    await client.chatCompletion(basicInput);

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.response_format).toBeUndefined();
  });

  it("normalizes a 4xx error response into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } })
    );
    const client = new GroqClient({ apiKey: "bad-key", fetchImpl });

    const result = await client.chatCompletion(basicInput);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.raw_error).toContain("Invalid API Key");
    }
  });

  it("normalizes a response with no choices into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { choices: [] }));
    const client = new GroqClient({ apiKey: "test-key", fetchImpl });

    const result = await client.chatCompletion(basicInput);

    expect(result.status).toBe("failed");
  });

  it("normalizes a network failure into a failed result instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new GroqClient({ apiKey: "test-key", fetchImpl });

    const result = await client.chatCompletion(basicInput);

    expect(result).toEqual({ status: "failed", raw_error: "ECONNREFUSED" });
  });

  it("uses a tight default timeout and resolves as a normalized failure instead of hanging", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, requestInit: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        requestInit.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    });
    const client = new GroqClient({ apiKey: "test-key", fetchImpl, timeoutMs: 20 });

    const result = await client.chatCompletion(basicInput);

    expect(result.status).toBe("failed");
  });
});
