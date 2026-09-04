import { describe, it, expect, vi } from "vitest";
import { JsonWebKey } from "node:crypto";
import { runBuyerAgent } from "../../src/agent/loop";
import { GenerateContentInput, GenerateContentResult } from "../../src/agent/gemini-client";

function fakeContentGenerator(responses: GenerateContentResult[]) {
  let call = 0;
  return {
    generateContent: vi.fn(async (_input: GenerateContentInput) => {
      const response = responses[Math.min(call, responses.length - 1)];
      call++;
      return response;
    }),
  };
}

const baseOpts = {
  goal: "buy some groceries",
  mandateId: "mandate-1",
  agentId: "buyer-agent-1",
  allowedCategories: ["groceries"],
  toolContext: { gatewayUrl: "http://unused.invalid", privateKeyJwk: {} as JsonWebKey },
};

describe("runBuyerAgent", () => {
  it("stops with goal_complete as soon as the model responds with no function call", async () => {
    const contentGenerator = fakeContentGenerator([{ status: "success", text: "All done, bought the rice.", functionCalls: [] }]);

    const transcript = await runBuyerAgent({ ...baseOpts, contentGenerator });

    expect(transcript.stopReason).toBe("goal_complete");
    expect(transcript.finalMessage).toBe("All done, bought the rice.");
    expect(transcript.turns).toHaveLength(1);
    expect(contentGenerator.generateContent).toHaveBeenCalledTimes(1);
  });

  it("executes a tool call, feeds the result back, and continues the loop", async () => {
    const contentGenerator = fakeContentGenerator([
      {
        status: "success",
        text: null,
        functionCalls: [{ name: "browse_catalog", args: { category: "groceries" } }],
      },
      { status: "success", text: "Found rice, done browsing.", functionCalls: [] },
    ]);

    const transcript = await runBuyerAgent({ ...baseOpts, contentGenerator });

    expect(transcript.stopReason).toBe("goal_complete");
    expect(transcript.turns).toHaveLength(2);
    expect(transcript.turns[0].toolCalls).toHaveLength(1);
    expect(transcript.turns[0].toolCalls[0].name).toBe("browse_catalog");
    expect(Array.isArray(transcript.turns[0].toolCalls[0].result)).toBe(true);

    // the tool result must have been fed back into the conversation before the second call
    const secondCallInput = contentGenerator.generateContent.mock.calls[1][0];
    const lastContent = secondCallInput.contents[secondCallInput.contents.length - 1];
    expect(lastContent.role).toBe("user");
    expect(lastContent.parts[0].functionResponse?.name).toBe("browse_catalog");
  });

  it("stops at the turn limit rather than looping forever", async () => {
    const contentGenerator = fakeContentGenerator([
      { status: "success", text: null, functionCalls: [{ name: "browse_catalog", args: {} }] },
    ]);

    const transcript = await runBuyerAgent({ ...baseOpts, contentGenerator, turnLimit: 3 });

    expect(transcript.stopReason).toBe("turn_limit_reached");
    expect(transcript.turns).toHaveLength(3);
    expect(contentGenerator.generateContent).toHaveBeenCalledTimes(3);
  });

  it("handles an unknown/malformed tool call without crashing the loop", async () => {
    const contentGenerator = fakeContentGenerator([
      { status: "success", text: null, functionCalls: [{ name: "delete_everything", args: {} }] },
      { status: "success", text: "Understood, stopping.", functionCalls: [] },
    ]);

    const transcript = await runBuyerAgent({ ...baseOpts, contentGenerator });

    expect(transcript.stopReason).toBe("goal_complete");
    expect(transcript.turns[0].toolCalls[0].result).toEqual({ error: "Unknown tool: delete_everything" });
  });

  it("stops gracefully (does not throw) when the Gemini call itself fails", async () => {
    const contentGenerator = fakeContentGenerator([{ status: "failed", raw_error: "API key not valid" }]);

    const transcript = await runBuyerAgent({ ...baseOpts, contentGenerator });

    expect(transcript.finalMessage).toContain("API key not valid");
  });

  it("passes the tool declarations and a system instruction mentioning the agent's allowed categories", async () => {
    const contentGenerator = fakeContentGenerator([{ status: "success", text: "done", functionCalls: [] }]);

    await runBuyerAgent({ ...baseOpts, contentGenerator });

    const input = contentGenerator.generateContent.mock.calls[0][0];
    expect(input.tools?.[0]?.functionDeclarations.map((d: { name: string }) => d.name).sort()).toEqual([
      "browse_catalog",
      "submit_purchase",
    ]);
    expect(input.systemInstruction?.parts[0]?.text).toContain("groceries");
  });
});
