import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { createMandateStore } from "../../src/mandate/store";
import { generateAgentKeypair } from "../../src/gateway/agent-signature";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function toolCallResponse(name: string, args: Record<string, unknown>) {
  return jsonResponse(200, {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });
}

function textResponse(text: string) {
  return jsonResponse(200, { choices: [{ message: { role: "assistant", content: text } }] });
}

describe("POST /agent/run", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let demoKeysPath: string;
  let mandateId: string;

  beforeEach(() => {
    db = buildTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-routes-test-"));
    demoKeysPath = path.join(dir, "demo-keys.json");

    const mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    const { publicKey, privateKeyJwk } = generateAgentKeypair();
    const mandate = mandateStore.create({
      user_id: "user-1",
      agent_id: "agent-1",
      agent_public_key: publicKey,
      category: ["groceries"],
      max_per_transaction: 1000,
      max_cumulative: 5000,
      rolling_window_seconds: 86400,
      expires_at: Date.now() + 1_000_000,
    });
    mandateId = mandate.mandate_id;

    fs.writeFileSync(demoKeysPath, JSON.stringify({ [mandateId]: { agent_id: "agent-1", privateKeyJwk } }));
  });

  afterEach(() => {
    fs.rmSync(path.dirname(demoKeysPath), { recursive: true, force: true });
  });

  function buildTestApp(fetchImpl?: typeof fetch) {
    return buildApp({ db, signingKey: TEST_SIGNING_KEY, groqApiKey: "test-groq-key", demoKeysPath, fetchImpl });
  }

  it("returns 404 when GROQ_API_KEY is not configured", async () => {
    const unconfiguredApp = buildApp({ db, signingKey: TEST_SIGNING_KEY, demoKeysPath });
    const res = await unconfiguredApp.inject({
      method: "POST",
      url: "/agent/run",
      payload: { mandate_id: mandateId, goal: "buy rice" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a missing goal", async () => {
    app = buildTestApp();
    const res = await app.inject({ method: "POST", url: "/agent/run", payload: { mandate_id: mandateId } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown mandate_id", async () => {
    app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/agent/run",
      payload: { mandate_id: "not-a-real-mandate", goal: "buy rice" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs the agent loop end to end over real HTTP and returns the transcript", async () => {
    let call = 0;
    const responses = [
      toolCallResponse("browse_catalog", { category: "groceries" }),
      toolCallResponse("submit_purchase", {
        item_id: "gro-rice-5kg",
        item_name: "Basmati rice, 5kg",
        category: "groceries",
        amount: 450,
      }),
      textResponse("Bought the rice."),
    ];
    // Only Groq's endpoint is faked -- the agent's own submit_purchase call
    // still goes out over real HTTP, self-referentially, to this same
    // server's /gateway/verify, exactly as scripts/run-buyer-agent.ts does
    // against an externally-running one. That's the property worth proving
    // here, not just that runBuyerAgent() works in isolation (already
    // covered by test/agent/loop.test.ts).
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("api.groq.com")) {
        return responses[Math.min(call++, responses.length - 1)];
      }
      throw new Error(`unexpected fetch to Groq mock from: ${url}`);
    }) as typeof fetch;

    app = buildTestApp(fetchImpl);
    await app.ready();
    const addr = await app.listen({ port: 0 });

    const res = await fetch(`${addr}/agent/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mandate_id: mandateId, goal: "buy some rice" }),
    });
    const body = (await res.json()) as { transcript: { stopReason: string; turns: unknown[] } };

    expect(res.status).toBe(200);
    expect(body.transcript.stopReason).toBe("goal_complete");
    expect(body.transcript.turns.length).toBeGreaterThan(0);

    await app.close();
  });
});
