import { createHmac } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { createMandateStore } from "../../src/mandate/store";
import { createOrdersStore } from "../../src/razorpay/orders-store";
import { createAuditStore } from "../../src/audit/store";

const WEBHOOK_SECRET = "test-webhook-secret";

function sign(body: string, secret: string = WEBHOOK_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function orderPaidBody(orderId: string, paymentId: string) {
  return JSON.stringify({
    event: "order.paid",
    payload: {
      order: { entity: { id: orderId, amount: 45000, status: "paid" } },
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 45000,
          status: "captured",
          error_code: null,
          error_description: null,
        },
      },
    },
  });
}

describe("POST /razorpay/webhook", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let mandateId: string;

  beforeEach(() => {
    db = buildTestDb();
    app = buildApp({ db, signingKey: TEST_SIGNING_KEY, razorpayWebhookSecret: WEBHOOK_SECRET });

    const mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    mandateId = mandateStore.create({
      user_id: "user-1",
      agent_id: "agent-1",
      agent_public_key: "pubkey-abc",
      category: ["groceries"],
      max_per_transaction: 500,
      max_cumulative: 2000,
      rolling_window_seconds: 86400,
      expires_at: Date.now() + 1000000,
    }).mandate_id;

    createOrdersStore(db).create({
      order_id: "order_abc",
      mandate_id: mandateId,
      agent_id: "agent-1",
      amount: 450,
      category: "groceries",
      receipt: "receipt-1",
    });
  });

  it("accepts a validly signed order.paid webhook and marks the order paid", async () => {
    const body = orderPaidBody("order_abc", "pay_1");
    const res = await app.inject({
      method: "POST",
      url: "/razorpay/webhook",
      headers: { "content-type": "application/json", "x-razorpay-signature": sign(body) },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(createOrdersStore(db).getByOrderId("order_abc")?.status).toBe("paid");
    const { entries } = createAuditStore(db).list({ decision: "payment_captured" });
    expect(entries).toHaveLength(1);
  });

  it("rejects a webhook with an invalid signature and leaves state unchanged", async () => {
    const body = orderPaidBody("order_abc", "pay_1");
    const res = await app.inject({
      method: "POST",
      url: "/razorpay/webhook",
      headers: { "content-type": "application/json", "x-razorpay-signature": sign(body, "wrong-secret") },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(createOrdersStore(db).getByOrderId("order_abc")?.status).toBe("created");
    const { entries } = createAuditStore(db).list();
    expect(entries).toHaveLength(0);
  });

  it("rejects a webhook with a missing signature header", async () => {
    const body = orderPaidBody("order_abc", "pay_1");
    const res = await app.inject({
      method: "POST",
      url: "/razorpay/webhook",
      headers: { "content-type": "application/json" },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects a tampered body even if it was signed before tampering", async () => {
    const body = orderPaidBody("order_abc", "pay_1");
    const signature = sign(body);
    const tampered = orderPaidBody("order_abc", "pay_evil");

    const res = await app.inject({
      method: "POST",
      url: "/razorpay/webhook",
      headers: { "content-type": "application/json", "x-razorpay-signature": signature },
      payload: tampered,
    });

    expect(res.statusCode).toBe(400);
    expect(createOrdersStore(db).getByOrderId("order_abc")?.status).toBe("created");
  });

  it("does not double-process a duplicate webhook delivery", async () => {
    const body = orderPaidBody("order_abc", "pay_1");
    const headers = { "content-type": "application/json", "x-razorpay-signature": sign(body) };

    const first = await app.inject({ method: "POST", url: "/razorpay/webhook", headers, payload: body });
    const second = await app.inject({ method: "POST", url: "/razorpay/webhook", headers, payload: body });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const { entries } = createAuditStore(db).list({ decision: "payment_captured" });
    expect(entries).toHaveLength(1);
  });

  it("does not register the webhook route when razorpayWebhookSecret is not configured", async () => {
    const unconfiguredDb = buildTestDb();
    const unconfiguredApp = buildApp({ db: unconfiguredDb, signingKey: TEST_SIGNING_KEY });

    const res = await unconfiguredApp.inject({
      method: "POST",
      url: "/razorpay/webhook",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(res.statusCode).toBe(404);
  });

  it("still parses normal JSON bodies correctly on unrelated routes", async () => {
    const res = await app.inject({ method: "GET", url: "/mandates" });
    expect(res.statusCode).toBe(200);
  });
});
