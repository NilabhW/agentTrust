import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { createMandateStore } from "../../src/mandate/store";
import { generateAgentKeypair } from "../../src/gateway/agent-signature";
import {
  browseCatalog,
  submitPurchase,
  executeToolCall,
  TOOL_DECLARATIONS,
} from "../../src/agent/tools";

describe("browseCatalog", () => {
  it("returns the full catalog with no category filter", () => {
    const result = browseCatalog({});
    expect(result.length).toBeGreaterThan(0);
  });

  it("filters by category", () => {
    const result = browseCatalog({ category: "groceries" });
    expect(result.every((item) => item.category === "groceries")).toBe(true);
  });
});

describe("TOOL_DECLARATIONS", () => {
  it("declares exactly browse_catalog and submit_purchase", () => {
    expect(TOOL_DECLARATIONS.map((d) => d.name).sort()).toEqual(["browse_catalog", "submit_purchase"]);
  });
});

describe("submitPurchase (real HTTP round trip against a running Gateway)", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let baseUrl: string;
  let mandateId: string;
  let privateKeyJwk: ReturnType<typeof generateAgentKeypair>["privateKeyJwk"];

  beforeEach(async () => {
    db = buildTestDb();
    app = buildApp({ db, signingKey: TEST_SIGNING_KEY, stepUpTimeoutMs: 300_000 });
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    const { publicKey, privateKeyJwk: pk } = generateAgentKeypair();
    privateKeyJwk = pk;
    const mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    mandateId = mandateStore.create({
      user_id: "user-1",
      agent_id: "buyer-agent-1",
      agent_public_key: publicKey,
      category: ["groceries"],
      max_per_transaction: 1000,
      max_cumulative: 5000,
      rolling_window_seconds: 86400,
      expires_at: Date.now() + 1_000_000,
    }).mandate_id;
  });

  afterEach(async () => {
    await app.close();
  });

  it("signs the request and gets a real pass decision back over HTTP", async () => {
    const result = (await submitPurchase(
      { item_id: "gro-rice-5kg", item_name: "Basmati rice, 5kg", amount: 450, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string; order_id: string | null };

    expect(result.decision).toBe("pass");
    expect(result.order_id).toBeNull();
  });

  it("gets a real hard_fail decision for an out-of-scope category", async () => {
    const result = (await submitPurchase(
      { item_id: "elec-coffee-machine", item_name: "Premium espresso coffee machine", amount: 18999, category: "electronics" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string; reason: string };

    expect(result.decision).toBe("hard_fail");
    expect(result.reason).toContain("category");
  });

  it("gets a real step_up decision when cumulative spend would be exceeded", async () => {
    await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    );
    const second = (await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string };
    const third = (await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string };
    const fourth = (await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string };
    const fifth = (await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string };
    const sixth = (await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string };
    const seventh = (await submitPurchase(
      { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { decision: string };

    const decisions = [second.decision, third.decision, fourth.decision, fifth.decision, sixth.decision, seventh.decision];
    expect(decisions).toContain("step_up");
  });

  it("never exposes pending_approval_id to the caller, matching the real /gateway/verify contract", async () => {
    for (let i = 0; i < 7; i++) {
      const result = (await submitPurchase(
        { item_id: "gro-milk-12", item_name: "Milk, 1L x 12", amount: 720, category: "groceries" },
        { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
      )) as Record<string, unknown>;
      expect(result.pending_approval_id).toBeUndefined();
    }
  });

  it("returns an error object instead of throwing when the mandate_id is unknown", async () => {
    const { privateKeyJwk: otherKey } = generateAgentKeypair();
    const result = (await submitPurchase(
      { item_id: "gro-rice-5kg", item_name: "Basmati rice, 5kg", amount: 450, category: "groceries" },
      { mandateId: "does-not-exist", privateKeyJwk: otherKey, gatewayUrl: baseUrl }
    )) as { decision: string };

    expect(result.decision).toBe("hard_fail");
  });

  it("returns an error object instead of throwing when required args are missing", async () => {
    const result = (await submitPurchase(
      { item_id: "gro-rice-5kg" },
      { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
    )) as { error: string };

    expect(result.error).toBeDefined();
  });

  describe("executeToolCall dispatcher", () => {
    it("dispatches browse_catalog", async () => {
      const result = await executeToolCall(
        { name: "browse_catalog", args: { category: "subscriptions" } },
        { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it("dispatches submit_purchase", async () => {
      const result = (await executeToolCall(
        { name: "submit_purchase", args: { item_id: "gro-rice-5kg", item_name: "Basmati rice, 5kg", amount: 450, category: "groceries" } },
        { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
      )) as { decision: string };
      expect(result.decision).toBe("pass");
    });

    it("returns an error object for an unknown tool name, without throwing", async () => {
      const result = (await executeToolCall(
        { name: "delete_everything", args: {} },
        { mandateId, privateKeyJwk, gatewayUrl: baseUrl }
      )) as { error: string };
      expect(result.error).toContain("delete_everything");
    });
  });
});
