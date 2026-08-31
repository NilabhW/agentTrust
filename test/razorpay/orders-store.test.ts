import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { createMandateStore, MandateStore } from "../../src/mandate/store";
import { CreateMandateInput } from "../../src/mandate/types";
import { createOrdersStore, OrdersStore } from "../../src/razorpay/orders-store";
import { OrderNotFoundError } from "../../src/razorpay/errors";

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

describe("OrdersStore", () => {
  let db: Database.Database;
  let mandateStore: MandateStore;
  let store: OrdersStore;
  let mandateId: string;

  beforeEach(() => {
    db = buildTestDb();
    mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    store = createOrdersStore(db);
    mandateId = mandateStore.create(validMandateInput()).mandate_id;
  });

  function validInput(overrides: Partial<Parameters<OrdersStore["create"]>[0]> = {}) {
    return {
      order_id: "order_abc123",
      mandate_id: mandateId,
      agent_id: "agent-1",
      amount: 450,
      category: "groceries",
      receipt: "receipt-1",
      ...overrides,
    };
  }

  it("creates an order with status created", () => {
    const order = store.create(validInput());
    expect(order.status).toBe("created");
    expect(order.order_id).toBe("order_abc123");
    expect(order.payment_id).toBeNull();
    expect(order.currency).toBe("INR");
  });

  it("fetches a created order by order_id", () => {
    store.create(validInput());
    const order = store.getByOrderId("order_abc123");
    expect(order?.mandate_id).toBe(mandateId);
  });

  it("returns undefined for an unknown order_id", () => {
    expect(store.getByOrderId("does-not-exist")).toBeUndefined();
  });

  it("marks an order paid and records the payment_id", () => {
    store.create(validInput());
    const result = store.markPaid("order_abc123", "pay_1", Date.now());
    expect(result.alreadyProcessed).toBe(false);
    expect(result.order.status).toBe("paid");
    expect(result.order.payment_id).toBe("pay_1");
  });

  it("is idempotent when marking an already-paid order paid again", () => {
    store.create(validInput());
    store.markPaid("order_abc123", "pay_1", Date.now());
    const second = store.markPaid("order_abc123", "pay_1", Date.now());
    expect(second.alreadyProcessed).toBe(true);
    expect(second.order.status).toBe("paid");
  });

  it("marks an order failed and records the payment_id", () => {
    store.create(validInput());
    const result = store.markFailed("order_abc123", "pay_2", Date.now());
    expect(result.alreadyProcessed).toBe(false);
    expect(result.order.status).toBe("failed");
    expect(result.order.payment_id).toBe("pay_2");
  });

  it("is idempotent when marking an already-failed order failed again", () => {
    store.create(validInput());
    store.markFailed("order_abc123", "pay_2", Date.now());
    const second = store.markFailed("order_abc123", "pay_2", Date.now());
    expect(second.alreadyProcessed).toBe(true);
  });

  it("treats marking a paid order as failed as already processed (no state change)", () => {
    store.create(validInput());
    store.markPaid("order_abc123", "pay_1", Date.now());
    const result = store.markFailed("order_abc123", "pay_1", Date.now());
    expect(result.alreadyProcessed).toBe(true);
    expect(result.order.status).toBe("paid");
  });

  it("lets a later order.paid win over a prior payment.failed on the same order (retried payment succeeds)", () => {
    store.create(validInput());
    store.markFailed("order_abc123", "pay_declined", Date.now());
    const result = store.markPaid("order_abc123", "pay_retry", Date.now());
    expect(result.alreadyProcessed).toBe(false);
    expect(result.order.status).toBe("paid");
    expect(result.order.payment_id).toBe("pay_retry");
  });

  it("processes a second, distinct failed attempt on a still-open order rather than treating it as a duplicate", () => {
    store.create(validInput());
    store.markFailed("order_abc123", "pay_declined_1", Date.now());
    const result = store.markFailed("order_abc123", "pay_declined_2", Date.now());
    expect(result.alreadyProcessed).toBe(false);
    expect(result.order.payment_id).toBe("pay_declined_2");
  });

  it("throws OrderNotFoundError when marking an unknown order paid", () => {
    expect(() => store.markPaid("unknown", "pay_1", Date.now())).toThrow(OrderNotFoundError);
  });

  it("throws OrderNotFoundError when marking an unknown order failed", () => {
    expect(() => store.markFailed("unknown", "pay_1", Date.now())).toThrow(OrderNotFoundError);
  });
});
