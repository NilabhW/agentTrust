import { AuditStore } from "../audit/store";
import { OrdersStore } from "./orders-store";
import { RazorpayWebhookPayload } from "./types";

export class WebhookService {
  constructor(
    private readonly ordersStore: OrdersStore,
    private readonly auditStore: AuditStore
  ) {}

  handleEvent(body: RazorpayWebhookPayload, now: number = Date.now()): void {
    // Signature verification (routes.ts) only proves the bytes came from
    // Razorpay -- it says nothing about their shape. A structurally
    // unexpected but validly-signed body must not throw: an uncaught
    // exception here would surface as a 500, and Razorpay retry-storms on
    // non-2xx responses for something a retry can never fix.
    if (!body || typeof body !== "object" || !body.payload || typeof body.payload !== "object") {
      return;
    }

    if (body.event === "order.paid") {
      this.handleOrderPaid(body, now);
    } else if (body.event === "payment.failed") {
      this.handlePaymentFailed(body, now);
    }
    // Any other event name is intentionally a no-op: the buildspec scopes
    // Program 3 to exactly order.paid/payment.failed, and acking unhandled
    // events with 200 avoids Razorpay retry-storming us for events we don't
    // process.
  }

  private handleOrderPaid(body: RazorpayWebhookPayload, now: number): void {
    const paymentEntity = body.payload.payment?.entity;
    const orderId = body.payload.order?.entity.id ?? paymentEntity?.order_id ?? null;
    if (!orderId) return;

    const order = this.ordersStore.getByOrderId(orderId);
    if (!order) return;

    const paymentId = paymentEntity?.id ?? "unknown";
    const result = this.ordersStore.markPaid(orderId, paymentId, now);
    if (result.alreadyProcessed) return;

    this.auditStore.writeEntry({
      mandate_id: order.mandate_id,
      agent_id: order.agent_id,
      request_amount: order.amount,
      category: order.category,
      decision: "payment_captured",
      reason: "Razorpay payment captured",
      order_id: orderId,
      payment_id: paymentId,
      created_at: now,
    });
  }

  private handlePaymentFailed(body: RazorpayWebhookPayload, now: number): void {
    const paymentEntity = body.payload.payment?.entity;
    const orderId = paymentEntity?.order_id ?? null;
    if (!orderId) return;

    const order = this.ordersStore.getByOrderId(orderId);
    if (!order) return;

    const paymentId = paymentEntity?.id ?? "unknown";
    const result = this.ordersStore.markFailed(orderId, paymentId, now);
    if (result.alreadyProcessed) return;

    const reason = paymentEntity?.error_description
      ? `Razorpay payment declined: ${paymentEntity.error_description}`
      : "Razorpay payment declined";

    this.auditStore.writeEntry({
      mandate_id: order.mandate_id,
      agent_id: order.agent_id,
      request_amount: order.amount,
      category: order.category,
      decision: "payment_failed",
      reason,
      order_id: orderId,
      payment_id: paymentId,
      created_at: now,
    });
  }
}
