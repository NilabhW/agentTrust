import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID, JsonWebKey } from "node:crypto";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { generateAgentKeypair, signAgentRequest, AgentSignedPayload } from "../../src/gateway/agent-signature";

const STEP_UP_TIMEOUT_MS = 300_000;

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function signedBody(privateKeyJwk: JsonWebKey, payload: Partial<AgentSignedPayload> & { mandate_id: string }) {
  const fullPayload: AgentSignedPayload = {
    amount: 100,
    category: "groceries",
    item_description: "weekly groceries",
    timestamp: Date.now(),
    nonce: randomUUID(),
    ...payload,
  };
  const agent_signature = signAgentRequest(fullPayload, privateKeyJwk);
  return { ...fullPayload, agent_signature };
}

describe("GatewayService + Upsell integration", () => {
  let db: Database.Database;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createMandate(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
    const { publicKey, privateKeyJwk } = generateAgentKeypair();
    const res = await app.inject({
      method: "POST",
      url: "/mandates",
      payload: {
        user_id: "user-1",
        agent_id: "agent-1",
        agent_public_key: publicKey,
        category: ["groceries"],
        max_per_transaction: 1500,
        max_cumulative: 5000,
        rolling_window_seconds: 86400,
        expires_at: Date.now() + 1000000,
        ...overrides,
      },
    });
    const mandate = res.json();
    return { mandate, privateKeyJwk };
  }

  beforeEach(() => {
    db = buildTestDb();
  });

  it("does not delay the purchase response while a slow upsell suggestion resolves in the background", async () => {
    const GROQ_DELAY_MS = 150;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes("api.razorpay.com")) {
          return jsonResponse(200, { id: "order_test_001", status: "created" });
        }
        if (String(url).includes("api.groq.com")) {
          await new Promise((resolve) => setTimeout(resolve, GROQ_DELAY_MS));
          return jsonResponse(200, {
            choices: [{ message: { content: JSON.stringify({ item_id: "gro-eggs-30", reason: "goes well" }) } }],
          });
        }
        throw new Error(`Unexpected fetch to ${url}`);
      })
    );

    const app = buildApp({
      db,
      signingKey: TEST_SIGNING_KEY,
      stepUpTimeoutMs: STEP_UP_TIMEOUT_MS,
      razorpayKeyId: "key_id",
      razorpayKeySecret: "key_secret",
      groqApiKey: "groq_key",
    });

    const { mandate, privateKeyJwk } = await createMandate(app);
    const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 450 });

    const start = Date.now();
    const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(GROQ_DELAY_MS);

    // Immediately after the purchase response, the upsell hasn't landed yet.
    const immediatelyAfter = (await app.inject({ method: "GET", url: "/upsell/pending" })).json();
    expect(immediatelyAfter).toHaveLength(0);

    // Give the fire-and-forget suggestion time to actually complete.
    await new Promise((resolve) => setTimeout(resolve, GROQ_DELAY_MS + 100));

    const afterWaiting = (await app.inject({ method: "GET", url: "/upsell/pending" })).json();
    expect(afterWaiting).toHaveLength(1);
    expect(afterWaiting[0].item_id).toBe("gro-eggs-30");
  });

  it("stays byte-identical to the unconfigured behavior when GROQ_API_KEY is absent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_test_002", status: "created" }));
    vi.stubGlobal("fetch", fetchSpy);

    const app = buildApp({
      db,
      signingKey: TEST_SIGNING_KEY,
      stepUpTimeoutMs: STEP_UP_TIMEOUT_MS,
      razorpayKeyId: "key_id",
      razorpayKeySecret: "key_secret",
    });

    const { mandate, privateKeyJwk } = await createMandate(app);
    const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 450 });
    const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
    expect(res.statusCode).toBe(200);

    // No Groq call was ever made (only the Razorpay order-creation call).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("api.razorpay.com");

    const pendingRes = await app.inject({ method: "GET", url: "/upsell/pending" });
    expect(pendingRes.statusCode).toBe(404);

    const audit = (await app.inject({ method: "GET", url: "/audit" })).json();
    const decisions = audit.entries.map((e: { decision: string }) => e.decision);
    expect(decisions).not.toContain("upsell_suggested");
  });
});
