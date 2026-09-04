import { describe, expect, it, vi } from "vitest";
import { GroqAgentClient } from "../../src/agent/groq-agent-client";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function chatResponse(message: Record<string, unknown>) {
  return { choices: [{ message }] };
}

const basicInput = {
  contents: [{ role: "user" as const, parts: [{ text: "hello" }] }],
};

describe("GroqAgentClient.generateContent", () => {
  it("returns plain text when the model responds with no tool calls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatResponse({ role: "assistant", content: "Hi there" })));
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result).toEqual({ status: "success", text: "Hi there", functionCalls: [] });
  });

  it("extracts a single tool call, parsing the JSON-string arguments", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "browse_catalog", arguments: JSON.stringify({ category: "groceries" }) },
            },
          ],
        })
      )
    );
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result).toEqual({
      status: "success",
      text: null,
      functionCalls: [{ name: "browse_catalog", args: { category: "groceries" } }],
    });
  });

  it("extracts multiple tool calls from one response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "browse_catalog", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "submit_purchase", arguments: '{"amount":100}' } },
          ],
        })
      )
    );
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.functionCalls).toHaveLength(2);
      expect(result.functionCalls.map((c) => c.name)).toEqual(["browse_catalog", "submit_purchase"]);
    }
  });

  it("sends the API key via the Authorization Bearer header", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatResponse({ role: "assistant", content: "ok" })));
    const client = new GroqAgentClient({ apiKey: "secret-key-123", fetchImpl });

    await client.generateContent(basicInput);

    const [url, requestInit] = fetchImpl.mock.calls[0];
    expect(requestInit.headers.Authorization).toBe("Bearer secret-key-123");
    expect(String(url)).not.toContain("secret-key-123");
  });

  it("translates systemInstruction into a leading system message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatResponse({ role: "assistant", content: "ok" })));
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    await client.generateContent({ ...basicInput, systemInstruction: { parts: [{ text: "system prompt" }] } });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.messages[0]).toEqual({ role: "system", content: "system prompt" });
  });

  it("translates Gemini-shaped functionDeclarations into OpenAI-shaped tools", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatResponse({ role: "assistant", content: "ok" })));
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });
    const tools = [
      { functionDeclarations: [{ name: "browse_catalog", description: "browse", parameters: { type: "object" } }] },
    ];

    await client.generateContent({ ...basicInput, tools });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.tools).toEqual([
      { type: "function", function: { name: "browse_catalog", description: "browse", parameters: { type: "object" } } },
    ]);
  });

  it("round-trips a model turn's functionCall into an assistant tool_calls message, and the following functionResponse into a matching tool message", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatResponse({ role: "assistant", content: "done" })));
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    await client.generateContent({
      contents: [
        { role: "user", parts: [{ text: "buy rice" }] },
        { role: "model", parts: [{ functionCall: { name: "submit_purchase", args: { amount: 100 } } }] },
        {
          role: "user",
          parts: [{ functionResponse: { name: "submit_purchase", response: { result: { decision: "pass" } } } }],
        },
      ],
    });

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    const assistantMsg = sentBody.messages.find((m: { role: string }) => m.role === "assistant");
    const toolMsg = sentBody.messages.find((m: { role: string }) => m.role === "tool");
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0].function.name).toBe("submit_purchase");
    expect(JSON.parse(assistantMsg.tool_calls[0].function.arguments)).toEqual({ amount: 100 });
    expect(toolMsg.tool_call_id).toBe(assistantMsg.tool_calls[0].id);
    expect(JSON.parse(toolMsg.content)).toEqual({ result: { decision: "pass" } });
  });

  it("uses the configured model in the request body, defaulting sensibly", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, chatResponse({ role: "assistant", content: "ok" })));
    const client = new GroqAgentClient({ apiKey: "test-key", model: "groq-test-model", fetchImpl });

    await client.generateContent(basicInput);

    const [, requestInit] = fetchImpl.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.model).toBe("groq-test-model");
  });

  it("normalizes a 4xx error response into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(401, { error: { message: "Invalid API Key", type: "invalid_request_error" } })
    );
    const client = new GroqAgentClient({ apiKey: "bad-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.raw_error).toContain("Invalid API Key");
    }
  });

  it("normalizes a response with no choices/message into a failed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { choices: [] }));
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
  });

  it("normalizes malformed tool_call arguments JSON into a failed result instead of throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        200,
        chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "browse_catalog", arguments: "{not json" } }],
        })
      )
    );
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
  });

  it("normalizes a network failure into a failed result instead of throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl });

    const result = await client.generateContent(basicInput);

    expect(result).toEqual({ status: "failed", raw_error: "ECONNREFUSED" });
  });

  it("resolves as a normalized failure instead of hanging forever when the request times out", async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string, requestInit: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        requestInit.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      });
    });
    const client = new GroqAgentClient({ apiKey: "test-key", fetchImpl, timeoutMs: 20 });

    const result = await client.generateContent(basicInput);

    expect(result.status).toBe("failed");
  });
});
