import type Database from "better-sqlite3";
import { OrderNotFoundError } from "./errors";
import { MarkOrderResult, OrderRecord, StoredOrderRow } from "./types";

export interface CreateOrderRecordInput {
  order_id: string;
  mandate_id: string;
  agent_id: string;
  amount: number;
  category: string;
  receipt: string;
  currency?: string;
}

function toOrder(row: StoredOrderRow): OrderRecord {
  return { ...row };
}

export class OrdersStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateOrderRecordInput, now: number = Date.now()): OrderRecord {
    const currency = input.currency ?? "INR";
    this.db
      .prepare(
        `INSERT INTO orders
          (order_id, mandate_id, agent_id, amount, currency, category, receipt, status, created_at, updated_at, payment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, NULL)`
      )
      .run(
        input.order_id,
        input.mandate_id,
        input.agent_id,
        input.amount,
        currency,
        input.category,
        input.receipt,
        now,
        now
      );
    return this.getByOrderId(input.order_id)!;
  }

  getByOrderId(orderId: string): OrderRecord | undefined {
    const row = this.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(orderId) as
      | StoredOrderRow
      | undefined;
    return row ? toOrder(row) : undefined;
  }

  // Razorpay fires payment.failed per failed *attempt*, not per order -- the
  // order stays open and a retried payment can still succeed and fire
  // order.paid afterwards. So "paid" always wins over a prior "failed", and
  // a distinct new failed attempt (different payment_id) on a still-open
  // order is its own event, not a duplicate of the first failure. Only an
  // identical (status, payment_id) pair -- the exact same event redelivered
  // -- is treated as already processed. Every UPDATE is guarded by its own
  // WHERE clause and checked via `.changes` (not a separate SELECT) so two
  // processes racing on the same DB file can't both observe "not yet
  // processed" and both write a duplicate audit entry.
  markPaid(orderId: string, paymentId: string, now: number = Date.now()): MarkOrderResult {
    const current = this.getByOrderId(orderId);
    if (!current) throw new OrderNotFoundError(orderId);

    const result = this.db
      .prepare(
        `UPDATE orders SET status = 'paid', payment_id = ?, updated_at = ?
         WHERE order_id = ? AND NOT (status = 'paid' AND payment_id = ?)`
      )
      .run(paymentId, now, orderId, paymentId);

    if (result.changes !== 1) {
      return { order: this.getByOrderId(orderId)!, alreadyProcessed: true };
    }
    return { order: this.getByOrderId(orderId)!, alreadyProcessed: false };
  }

  markFailed(orderId: string, paymentId: string, now: number = Date.now()): MarkOrderResult {
    const current = this.getByOrderId(orderId);
    if (!current) throw new OrderNotFoundError(orderId);

    if (current.status === "paid") {
      // A stale/out-of-order failed event for an order that already
      // succeeded -- paid wins, this is a no-op.
      return { order: current, alreadyProcessed: true };
    }

    const result = this.db
      .prepare(
        `UPDATE orders SET status = 'failed', payment_id = ?, updated_at = ?
         WHERE order_id = ? AND status != 'paid' AND NOT (status = 'failed' AND payment_id = ?)`
      )
      .run(paymentId, now, orderId, paymentId);

    if (result.changes !== 1) {
      return { order: this.getByOrderId(orderId)!, alreadyProcessed: true };
    }
    return { order: this.getByOrderId(orderId)!, alreadyProcessed: false };
  }
}

export function createOrdersStore(db: Database.Database): OrdersStore {
  return new OrdersStore(db);
}
