import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { randomUUID, JsonWebKey } from "node:crypto";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { generateAgentKeypair, signAgentRequest, AgentSignedPayload } from "../../src/gateway/agent-signature";

const STEP_UP_TIMEOUT_MS = 300_000;

describe("Verification Gateway routes", () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb();
    app = buildApp({
      db,
      signingKey: TEST_SIGNING_KEY,
      replaySkewMs: 120_000,
      stepUpTimeoutMs: STEP_UP_TIMEOUT_MS,
    });
  });

  async function createMandate(overrides: Record<string, unknown> = {}) {
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

  function signedBody(
    privateKeyJwk: JsonWebKey,
    payload: Partial<AgentSignedPayload> & { mandate_id: string }
  ) {
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

  async function findApprovalId(appInstance: FastifyInstance, mandateId: string): Promise<string> {
    // Mirrors the operator's real discovery path -- pending_approval_id is
    // never handed to the agent, so tests must find it the same way a human
    // operator would: by listing pending approvals.
    const pending = (await appInstance.inject({ method: "GET", url: "/gateway/pending-approvals" })).json();
    const match = pending.find((p: { mandate_id: string; id: string }) => p.mandate_id === mandateId);
    if (!match) throw new Error(`No pending approval found for mandate ${mandateId}`);
    return match.id as string;
  }

  describe("POST /gateway/verify", () => {
    it("1: well-formed, correctly-signed, in-bounds request passes; increment_spend runs; one pass audit entry", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.decision).toBe("pass");
      expect(result.order_id ?? null).toBeNull();

      const mandateAfter = (await app.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
      expect(mandateAfter.current_cumulative_spend).toBe(100);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0].decision).toBe("pass");
    });

    it("2: tampered payload after signing is hard rejected as invalid signature", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });
      const tampered = { ...body, amount: 999 };

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: tampered });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "invalid signature" });
    });

    it("2b: signature from an unrelated keypair is hard rejected as invalid signature", async () => {
      const { mandate } = await createMandate();
      const { privateKeyJwk: unrelatedKey } = generateAgentKeypair();
      const body = signedBody(unrelatedKey, { mandate_id: mandate.mandate_id, amount: 100 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "invalid signature" });
    });

    it("3: request against an expired mandate is hard rejected", async () => {
      const { mandate, privateKeyJwk } = await createMandate({ expires_at: Date.now() + 10 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "mandate expired" });
    });

    it("4: request against a revoked mandate is hard rejected", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      await app.inject({ method: "POST", url: `/mandates/${mandate.mandate_id}/revoke` });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "mandate revoked" });
    });

    it("5: category outside scope is hard rejected", async () => {
      const { mandate, privateKeyJwk } = await createMandate({ category: ["groceries"] });
      const body = signedBody(privateKeyJwk, {
        mandate_id: mandate.mandate_id,
        amount: 100,
        category: "electronics",
      });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "category not in scope" });
    });

    it("6: amount over max_per_transaction is hard rejected", async () => {
      const { mandate, privateKeyJwk } = await createMandate({ max_per_transaction: 500 });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 501 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.json()).toMatchObject({
        decision: "hard_fail",
        reason: "amount exceeds max_per_transaction",
      });
    });

    it("7: request that would push cumulative spend over max_cumulative triggers step_up", async () => {
      const { mandate, privateKeyJwk } = await createMandate({
        max_per_transaction: 1000,
        max_cumulative: 1000,
      });
      const first = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 500 });
      await app.inject({ method: "POST", url: "/gateway/verify", payload: first });

      const second = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: second });
      expect(res.statusCode).toBe(200);
      const result = res.json();
      expect(result.decision).toBe("step_up");
      // pending_approval_id is deliberately NOT in the agent-facing response
      // (see routes.ts) -- the agent must never learn its own approval id.
      expect(result.pending_approval_id).toBeUndefined();

      const pending = (await app.inject({ method: "GET", url: "/gateway/pending-approvals" })).json();
      expect(pending.some((p: { mandate_id: string }) => p.mandate_id === mandate.mandate_id)).toBe(true);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries.some((e: { decision: string }) => e.decision === "step_up_requested")).toBe(true);
    });

    it("9: unknown mandate_id is a 200 hard_fail 'mandate not found', with an audit entry", async () => {
      const { privateKeyJwk } = generateAgentKeypair();
      const body = signedBody(privateKeyJwk, { mandate_id: "does-not-exist", amount: 100 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "mandate not found" });

      const audit = (await app.inject({ method: "GET", url: "/audit?mandate_id=does-not-exist" })).json();
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0].reason).toBe("mandate not found");
    });

    it("10: the same signed request sent twice is rejected as a duplicate on the second send", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });

      const first = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(first.json().decision).toBe("pass");

      const second = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(second.json()).toMatchObject({ decision: "hard_fail", reason: "duplicate request" });
    });

    it("11: a timestamp far outside the allowed skew is rejected as stale", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      const body = signedBody(privateKeyJwk, {
        mandate_id: mandate.mandate_id,
        amount: 100,
        timestamp: Date.now() - 10 * 60 * 1000,
      });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.json()).toMatchObject({ decision: "hard_fail", reason: "stale request" });
    });

    it("12: a malformed body (missing nonce) returns 400 with no audit entry written", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });
      const { nonce: _omit, ...malformed } = body;

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: malformed });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/nonce/);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries).toHaveLength(0);
    });

    it("13: a tampered mandate row (integrity failure) returns 500 with exactly one hard_fail audit entry", async () => {
      const { mandate, privateKeyJwk } = await createMandate();
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(999999, mandate.mandate_id);
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 100 });

      const res = await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("MANDATE_SIGNATURE_INVALID");

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        decision: "hard_fail",
        reason: "mandate integrity check failed",
      });
    });
  });

  describe("POST /gateway/pending-approvals/:id/approve", () => {
    async function createStepUp() {
      const { mandate, privateKeyJwk } = await createMandate({ max_per_transaction: 1000, max_cumulative: 500 });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      const approvalId = await findApprovalId(app, mandate.mandate_id);
      return { mandate, approvalId };
    }

    it("8: human approves the step-up; increment_spend runs; audit shows step_up_approved", async () => {
      const { mandate, approvalId } = await createStepUp();
      const res = await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/approve` });
      expect(res.statusCode).toBe(200);

      const mandateAfter = (await app.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
      expect(mandateAfter.current_cumulative_spend).toBe(600);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries.some((e: { decision: string }) => e.decision === "step_up_approved")).toBe(true);
      expect(audit.entries.some((e: { decision: string }) => e.decision === "order_created")).toBe(false);
    });

    it("15: approving an unknown id returns 404", async () => {
      const res = await app.inject({ method: "POST", url: "/gateway/pending-approvals/does-not-exist/approve" });
      expect(res.statusCode).toBe(404);
    });

    it("16: approving an already-approved id returns 409 with no duplicate audit entry", async () => {
      const { mandate, approvalId } = await createStepUp();
      await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/approve` });
      const res = await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/approve` });
      expect(res.statusCode).toBe(409);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries.filter((e: { decision: string }) => e.decision === "step_up_approved")).toHaveLength(1);
    });

    it("regression: approving a step-up against a mandate revoked in the meantime is rejected, no spend recorded", async () => {
      const { mandate, approvalId } = await createStepUp();
      await app.inject({ method: "POST", url: `/mandates/${mandate.mandate_id}/revoke` });

      const res = await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/approve` });
      expect(res.statusCode).toBe(409);

      const mandateAfter = (await app.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
      expect(mandateAfter.current_cumulative_spend).toBe(0);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries).toContainEqual(
        expect.objectContaining({ decision: "hard_fail", reason: "mandate revoked" })
      );
      expect(audit.entries.some((e: { decision: string }) => e.decision === "step_up_approved")).toBe(false);
    });

    it("regression: approving a step-up against a mandate that expired in the meantime is rejected, no spend recorded", async () => {
      const { mandate, privateKeyJwk } = await createMandate({
        max_per_transaction: 1000,
        max_cumulative: 500,
        expires_at: Date.now() + 20,
      });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      const approvalId = await findApprovalId(app, mandate.mandate_id);

      await new Promise((resolve) => setTimeout(resolve, 30));

      const res = await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/approve` });
      expect(res.statusCode).toBe(409);

      const mandateAfter = (await app.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
      expect(mandateAfter.current_cumulative_spend).toBe(0);
    });

    it("17: approving a now-expired pending approval auto-denies via timeout instead", async () => {
      const db2 = buildTestDb();
      const shortApp = buildApp({ db: db2, signingKey: TEST_SIGNING_KEY, stepUpTimeoutMs: 10 });
      const { publicKey, privateKeyJwk } = generateAgentKeypair();
      const created = await shortApp.inject({
        method: "POST",
        url: "/mandates",
        payload: {
          user_id: "user-1",
          agent_id: "agent-1",
          agent_public_key: publicKey,
          category: ["groceries"],
          max_per_transaction: 1000,
          max_cumulative: 500,
          rolling_window_seconds: 86400,
          expires_at: Date.now() + 1000000,
        },
      });
      const mandate = created.json();
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await shortApp.inject({ method: "POST", url: "/gateway/verify", payload: body });
      const approvalId = await findApprovalId(shortApp, mandate.mandate_id);

      await new Promise((resolve) => setTimeout(resolve, 30));

      const res = await shortApp.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/approve` });
      expect(res.statusCode).toBe(409);

      const audit = (await shortApp.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries.some((e: { decision: string }) => e.decision === "step_up_timeout")).toBe(true);

      const mandateAfter = (await shortApp.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
      expect(mandateAfter.current_cumulative_spend).toBe(0);
    });
  });

  describe("POST /gateway/pending-approvals/:id/deny", () => {
    async function createStepUp() {
      const { mandate, privateKeyJwk } = await createMandate({ max_per_transaction: 1000, max_cumulative: 500 });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await app.inject({ method: "POST", url: "/gateway/verify", payload: body });
      const approvalId = await findApprovalId(app, mandate.mandate_id);
      return { mandate, approvalId };
    }

    it("9: human denies the step-up; audit shows step_up_denied; no spend recorded", async () => {
      const { mandate, approvalId } = await createStepUp();
      const res = await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/deny` });
      expect(res.statusCode).toBe(200);

      const mandateAfter = (await app.inject({ method: "GET", url: `/mandates/${mandate.mandate_id}` })).json();
      expect(mandateAfter.current_cumulative_spend).toBe(0);

      const audit = (await app.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries.some((e: { decision: string }) => e.decision === "step_up_denied")).toBe(true);
    });

    it("19: denying an unknown id returns 404", async () => {
      const res = await app.inject({ method: "POST", url: "/gateway/pending-approvals/does-not-exist/deny" });
      expect(res.statusCode).toBe(404);
    });

    it("20: denying an already-resolved id returns 409", async () => {
      const { approvalId } = await createStepUp();
      await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/deny` });
      const res = await app.inject({ method: "POST", url: `/gateway/pending-approvals/${approvalId}/deny` });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("GET /gateway/pending-approvals and GET /mandates/pending-approvals", () => {
    it("21: returns only genuinely still-pending approvals", async () => {
      const { mandate, privateKeyJwk } = await createMandate({ max_per_transaction: 1000, max_cumulative: 500 });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await app.inject({ method: "POST", url: "/gateway/verify", payload: body });

      const res = await app.inject({ method: "GET", url: "/gateway/pending-approvals" });
      expect(res.statusCode).toBe(200);
      const approvals = res.json();
      expect(approvals).toHaveLength(1);
      expect(approvals[0].mandate_id).toBe(mandate.mandate_id);
    });

    it("22/23: an expired approval is excluded and materializes exactly one step_up_timeout entry, not double-written on repeated reads", async () => {
      const db2 = buildTestDb();
      const shortApp = buildApp({ db: db2, signingKey: TEST_SIGNING_KEY, stepUpTimeoutMs: 10 });
      const { publicKey, privateKeyJwk } = generateAgentKeypair();
      const created = await shortApp.inject({
        method: "POST",
        url: "/mandates",
        payload: {
          user_id: "user-1",
          agent_id: "agent-1",
          agent_public_key: publicKey,
          category: ["groceries"],
          max_per_transaction: 1000,
          max_cumulative: 500,
          rolling_window_seconds: 86400,
          expires_at: Date.now() + 1000000,
        },
      });
      const mandate = created.json();
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await shortApp.inject({ method: "POST", url: "/gateway/verify", payload: body });

      await new Promise((resolve) => setTimeout(resolve, 30));

      const firstList = await shortApp.inject({ method: "GET", url: "/gateway/pending-approvals" });
      expect(firstList.json()).toHaveLength(0);
      const secondList = await shortApp.inject({ method: "GET", url: "/gateway/pending-approvals" });
      expect(secondList.json()).toHaveLength(0);

      const audit = (await shortApp.inject({ method: "GET", url: `/audit?mandate_id=${mandate.mandate_id}` })).json();
      expect(audit.entries.filter((e: { decision: string }) => e.decision === "step_up_timeout")).toHaveLength(1);
    });

    it("24: GET /mandates/pending-approvals returns identical data to GET /gateway/pending-approvals", async () => {
      const { mandate, privateKeyJwk } = await createMandate({ max_per_transaction: 1000, max_cumulative: 500 });
      const body = signedBody(privateKeyJwk, { mandate_id: mandate.mandate_id, amount: 600 });
      await app.inject({ method: "POST", url: "/gateway/verify", payload: body });

      const a = await app.inject({ method: "GET", url: "/gateway/pending-approvals" });
      const b = await app.inject({ method: "GET", url: "/mandates/pending-approvals" });
      expect(b.json()).toEqual(a.json());
    });
  });
});
