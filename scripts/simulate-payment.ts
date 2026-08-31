import { randomUUID } from "node:crypto";
import { signWebhookPayload } from "../src/razorpay/webhook-signature";
import { RazorpayWebhookPayload } from "../src/razorpay/types";

const [, , orderIdArg, amountArg, outcomeArg] = process.argv;

if (!orderIdArg || !amountArg) {
  console.error(
    "Usage: npm run simulate-payment -- <order_id> <amount_rupees> [paid|failed]\n" +
      "  order_id comes from a POST /gateway/verify response (or the audit log/UI) once Razorpay is configured."
  );
  process.exit(1);
}

const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!webhookSecret) {
  console.error(
    "RAZORPAY_WEBHOOK_SECRET is not set. Set it to the same value the running server has " +
      "(any local value is fine when only using this simulator -- Razorpay itself never needs to see it)."
  );
  process.exit(1);
}

const outcome = outcomeArg === "failed" ? "failed" : "paid";
const amountPaise = Math.round(Number(amountArg) * 100);
const paymentId = `pay_sim_${randomUUID().slice(0, 12)}`;

const webhookBody: RazorpayWebhookPayload =
  outcome === "paid"
    ? {
        event: "order.paid",
        payload: {
          order: { entity: { id: orderIdArg, amount: amountPaise, status: "paid" } },
          payment: {
            entity: {
              id: paymentId,
              order_id: orderIdArg,
              amount: amountPaise,
              status: "captured",
              error_code: null,
              error_description: null,
            },
          },
        },
      }
    : {
        event: "payment.failed",
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: orderIdArg,
              amount: amountPaise,
              status: "failed",
              error_code: "BAD_REQUEST_ERROR",
              error_description: "Simulated test-mode decline",
            },
          },
        },
      };

const rawBody = JSON.stringify(webhookBody);
const signature = signWebhookPayload(rawBody, webhookSecret);

console.log(`Simulated Razorpay '${webhookBody.event}' webhook body:`);
console.log(rawBody);
console.log("\nReady-to-paste curl command:\n");
console.log(
  `curl -X POST http://localhost:3000/razorpay/webhook ` +
    `-H "Content-Type: application/json" -H "X-Razorpay-Signature: ${signature}" -d '${rawBody}'`
);
