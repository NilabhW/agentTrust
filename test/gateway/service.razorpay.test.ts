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

describe("GatewayService + Razorpay integration", () => {
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
        max_per_transaction: 500,
        max_cumulative: 2000,
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

  it("populates order_id and writes an order_created audit entry when Razorpay is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_test_001", status: "created" }))
    );
    const app = buildApp({
      db,
      signingKey: TEST_SIGNING_KEY,
      stepUpTimeoutMs: STEP_UP_TIMEOUT_MS,
      razorpayKeyId: "key_id",
      razorpayKeySecret: "key_secret",
    });

    const { mandate, privateKeyJwk } = await createMandate(app);
    const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });
    const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ decision: "pass", order_id: "order_test_001" });

    const audit = (await app.inject({ method: "GET", url: "/audit" })).json();
    const decisions = audit.entries.map((e: { decision: string }) => e.decision);
    expect(decisions).toContain("order_created");
    const orderCreatedEntry = audit.entries.find((e: { decision: string }) => e.decision === "order_created");
    expect(orderCreatedEntry.order_id).toBe("order_test_001");
  });

  it("stays byte-identical to the unconfigured behavior when Razorpay env vars are absent", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const app = buildApp({ db, signingKey: TEST_SIGNING_KEY, stepUpTimeoutMs: STEP_UP_TIMEOUT_MS });

    const { mandate, privateKeyJwk } = await createMandate(app);
    const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });
    const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });

    expect(res.json()).toMatchObject({ decision: "pass", order_id: null });
    expect(fetchSpy).not.toHaveBeenCalled();

    const audit = (await app.inject({ method: "GET", url: "/audit" })).json();
    const decisions = audit.entries.map((e: { decision: string }) => e.decision);
    expect(decisions).not.toContain("order_created");
  });

  it("still increments spend and logs payment_failed if create_order() fails after a pass", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(400, { error: { description: "receipt already used" } }))
    );
    const app = buildApp({
      db,
      signingKey: TEST_SIGNING_KEY,
      stepUpTimeoutMs: STEP_UP_TIMEOUT_MS,
      razorpayKeyId: "key_id",
      razorpayKeySecret: "key_secret",
    });

    const { mandate, privateKeyJwk } = await createMandate(app);
    const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });
    const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });

    expect(res.json()).toMatchObject({ decision: "pass", order_id: null });

    const mandatesRes = (await app.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
    expect(mandatesRes.current_cumulative_spend).toBe(100);

    const audit = (await app.inject({ method: "GET", url: "/audit" })).json();
    const failedEntry = audit.entries.find((e: { decision: string }) => e.decision === "payment_failed");
    expect(failedEntry).toBeDefined();
    expect(failedEntry.reason).toContain("order creation failed");
    expect(failedEntry.reason).toContain("receipt already used");
  });

  it("writes an order_created entry after a step-up is approved when Razorpay is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { id: "order_test_002", status: "created" }))
    );
    const app = buildApp({
      db,
      signingKey: TEST_SIGNING_KEY,
      stepUpTimeoutMs: STEP_UP_TIMEOUT_MS,
      razorpayKeyId: "key_id",
      razorpayKeySecret: "key_secret",
    });

    const { mandate, privateKeyJwk } = await createMandate(app, { max_per_transaction: 5000, max_cumulative: 1000 });
    const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 1500 });
    const verifyRes = (await app.inject({ method: "POST", url: "/gateway/verify", payload: body })).json();
    expect(verifyRes.decision).toBe("step_up");

    const pending = (await app.inject({ method: "GET", url: "/gateway/pending-approvals" })).json();
    const approvalId = pending.find((p: { mandate_id: string }) => p.mandate_id === mandate.mandate_id).id;

    const approveRes = await app.inject({
      method: "POST",
      url: `/gateway/pending-approvals/${approvalId}/approve`,
    });
    expect(approveRes.statusCode).toBe(200);

    const audit = (await app.inject({ method: "GET", url: "/audit" })).json();
    const decisions = audit.entries.map((e: { decision: string }) => e.decision);
    expect(decisions).toContain("order_created");
  });
});
