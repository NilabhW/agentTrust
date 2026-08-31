import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { createMandateStore, MandateStore } from "../../src/mandate/store";
import { CreateMandateInput } from "../../src/mandate/types";
import { createAuditStore, AuditStore } from "../../src/audit/store";
import { createOrdersStore, OrdersStore } from "../../src/razorpay/orders-store";
import { WebhookService } from "../../src/razorpay/webhook-service";
import { RazorpayWebhookPayload } from "../../src/razorpay/types";

function validMandateInput(overrides: Partial<CreateMandateInput> = {}): CreateMandateInput {
  return {
    user_id: "user-1",
    agent_id: "agent-1",
    agent_public_key: "pubkey-abc",
    category: ["groceries"],
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 86400,
    expires_at: Date.now() + 1000000,
    ...overrides,
  };
}

function orderPaidPayload(orderId: string, paymentId: string): RazorpayWebhookPayload {
  return {
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
  };
}

function paymentFailedPayload(orderId: string, paymentId: string, description: string): RazorpayWebhookPayload {
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount: 45000,
          status: "failed",
          error_code: "BAD_REQUEST_ERROR",
          error_description: description,
        },
      },
    },
  };
}

describe("WebhookService", () => {
  let db: Database.Database;
  let mandateStore: MandateStore;
  let auditStore: AuditStore;
  let ordersStore: OrdersStore;
  let service: WebhookService;
  let mandateId: string;

  beforeEach(() => {
    db = buildTestDb();
    mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    auditStore = createAuditStore(db);
    ordersStore = createOrdersStore(db);
    service = new WebhookService(ordersStore, auditStore);
    mandateId = mandateStore.create(validMandateInput()).mandate_id;
    ordersStore.create({
      order_id: "order_abc",
      mandate_id: mandateId,
      agent_id: "agent-1",
      amount: 450,
      category: "groceries",
      receipt: "receipt-1",
    });
  });

  it("marks the order paid and writes one payment_captured audit entry on order.paid", () => {
    service.handleEvent(orderPaidPayload("order_abc", "pay_1"));

    expect(ordersStore.getByOrderId("order_abc")?.status).toBe("paid");
    const { entries } = auditStore.list({ decision: "payment_captured" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      mandate_id: mandateId,
      agent_id: "agent-1",
      category: "groceries",
      request_amount: 450,
      order_id: "order_abc",
      payment_id: "pay_1",
      decision: "payment_captured",
    });
  });

  it("does not double-write on a duplicate order.paid delivery", () => {
    service.handleEvent(orderPaidPayload("order_abc", "pay_1"));
    service.handleEvent(orderPaidPayload("order_abc", "pay_1"));

    const { entries } = auditStore.list({ decision: "payment_captured" });
    expect(entries).toHaveLength(1);
  });

  it("marks the order failed and writes a payment_failed audit entry with the error reason", () => {
    service.handleEvent(paymentFailedPayload("order_abc", "pay_2", "card declined"));

    expect(ordersStore.getByOrderId("order_abc")?.status).toBe("failed");
    const { entries } = auditStore.list({ decision: "payment_failed" });
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toContain("card declined");
    expect(entries[0].order_id).toBe("order_abc");
    expect(entries[0].payment_id).toBe("pay_2");
  });

  it("does not double-write on a duplicate payment.failed delivery", () => {
    service.handleEvent(paymentFailedPayload("order_abc", "pay_2", "card declined"));
    service.handleEvent(paymentFailedPayload("order_abc", "pay_2", "card declined"));

    const { entries } = auditStore.list({ decision: "payment_failed" });
    expect(entries).toHaveLength(1);
  });

  it("no-ops on an order.paid event for an unknown order_id", () => {
    expect(() => service.handleEvent(orderPaidPayload("does-not-exist", "pay_1"))).not.toThrow();
    const { entries } = auditStore.list();
    expect(entries).toHaveLength(0);
  });

  it("no-ops on an unrecognized event name", () => {
    expect(() =>
      service.handleEvent({ event: "payment.authorized", payload: {} } as RazorpayWebhookPayload)
    ).not.toThrow();
    const { entries } = auditStore.list();
    expect(entries).toHaveLength(0);
  });

  it("lets a later order.paid win and write payment_captured even after a prior payment.failed", () => {
    service.handleEvent(paymentFailedPayload("order_abc", "pay_declined", "card declined"));
    service.handleEvent(orderPaidPayload("order_abc", "pay_retry"));

    expect(ordersStore.getByOrderId("order_abc")?.status).toBe("paid");
    const { entries } = auditStore.list();
    const decisions = entries.map((e) => e.decision).sort();
    expect(decisions).toEqual(["payment_captured", "payment_failed"]);
  });

  it("does not throw on a signature-valid but structurally malformed body (no payload)", () => {
    expect(() =>
      service.handleEvent({ event: "order.paid" } as unknown as RazorpayWebhookPayload)
    ).not.toThrow();
    expect(auditStore.list().entries).toHaveLength(0);
  });

  it("does not throw on a null body", () => {
    expect(() => service.handleEvent(null as unknown as RazorpayWebhookPayload)).not.toThrow();
  });
});
