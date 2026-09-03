import { describe, expect, it, vi } from "vitest";
import { GeminiClient } from "../../src/agent/gemini-client";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function candidateWith(parts: unknown[]) {
  return { candidates: [{ content: { parts } }] };
}

const basicInput = {
  contents: [{ role: "user" as const, parts: [{ text: "hello" }] }],
};

describe("GeminiClient.generateContent", () => {
  it("returns plain text when the model responds with no function call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, candidateWith([{ text: "Hi there" }])));
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result).toEqual({ status: "success", text: "Hi there", functionCalls: [] });
  });

  it("extracts a single function call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, candidateWith([{ functionCall: { name: "browse_catalog", args: { category: "groceries" } } }]))
    );
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result).toEqual({
      status: "success",
      text: null,
      functionCalls: [{ name: "browse_catalog", args: { category: "groceries" } }],
    });
  });

  it("extracts multiple function calls from one response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        candidateWith([
          { functionCall: { name: "browse_catalog", args: {} } },
          { functionCall: { name: "submit_purchase", args: { amount: 100 } } },
        ])
      )
    );
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.functionCalls).toHaveLength(2);
      expect(result.functionCalls.map((c) => c.name)).toEqual(["browse_catalog", "submit_purchase"]);
    }
  });

  it("sends the API key via the x-goog-api-key header, not a query string", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, candidateWith([{ text: "ok" }])));
    const client = new GeminiClient({ apiKey: "secret-key-123", fetchImpl });

    await client.generateContent(basicInput);

    const [url, requestInit] = fetchImpl.mock.calls[0];
    expect(requestInit.headers["x-goog-api-key"]).toBe("secret-key-123");
    expect(String(url)).not.toContain("secret-key-123");
  });

  it("sends contents, tools, and systemInstruction through untouched", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, candidateWith([{ text: "ok" }])));
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl });

    const tools = [{ functionDeclarations: [{ name: "browse_catalog", description: "d", parameters: {} }] }];
    const systemInstruction = { parts: [{ text: "system prompt" }] };

    await client.generateContent({ ...basicInput, tools, systemInstruction });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.contents).toEqual(basicInput.contents);
    expect(sentBody.tools).toEqual(tools);
    expect(sentBody.systemInstruction).toEqual(systemInstruction);
  });

  it("uses the configured model in the URL, defaulting sensibly", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, candidateWith([{ text: "ok" }])));
    const client = new GeminiClient({ apiKey: "test-key", model: "gemini-test-model", fetchImpl });

    await client.generateContent(basicInput);

    const [url] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain("gemini-test-model:generateContent");
  });

  it("normalizes a 4xx error response into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(400, { error: { code: 400, message: "API key not valid", status: "INVALID_ARGUMENT" } })
    );
    const client = new GeminiClient({ apiKey: "bad-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.raw_error).toContain("API key not valid");
    }
  });

  it("normalizes a response with no candidates into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { candidates: [] }));
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
  });

  it("normalizes a network failure into a failed result instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result).toEqual({ status: "failed", raw_error: "ECONNREFUSED" });
  });

  it("resolves as a normalized failure instead of hanging forever when the request times out", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, requestInit: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        requestInit.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    });
    const client = new GeminiClient({ apiKey: "test-key", fetchImpl, timeoutMs: 20 });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
  });
});
