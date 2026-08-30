import { config } from "../src/config";
import { createDb } from "../src/db/client";
import { createMandateStore } from "../src/mandate/store";
import { createAuditStore } from "../src/audit/store";
import { WriteAuditEntryInput } from "../src/audit/types";

const db = createDb(config.dbPath);
const mandateStore = createMandateStore(db, config.mandateSigningKey);
const auditStore = createAuditStore(db);

const mandates = mandateStore.listAll();
if (mandates.length === 0) {
  console.error("No mandates found. Run `npm run seed` before `npm run seed:audit`.");
  process.exit(1);
}

const m = (i: number) => mandates[i % mandates.length];
const now = Date.now();
const MIN = 60 * 1000;

const entries: WriteAuditEntryInput[] = [
  {
    mandate_id: m(0).mandate_id,
    agent_id: m(0).agent_id,
    request_amount: 450,
    category: "groceries",
    decision: "pass",
    reason: "within per-transaction and cumulative bounds",
    created_at: now - 50 * MIN,
  },
  {
    mandate_id: m(0).mandate_id,
    agent_id: m(0).agent_id,
    request_amount: 450,
    category: "groceries",
    decision: "order_created",
    reason: "Razorpay order created after pass",
    order_id: "order_demo_1",
    created_at: now - 49 * MIN,
  },
  {
    mandate_id: m(1).mandate_id,
    agent_id: m(1).agent_id,
    request_amount: 50000,
    category: "electronics",
    decision: "hard_fail",
    reason: "amount exceeds max_per_transaction",
    created_at: now - 45 * MIN,
  },
  {
    mandate_id: "unknown-mandate-demo",
    agent_id: "agent-unknown",
    request_amount: 100,
    category: "subscriptions",
    decision: "hard_fail",
    reason: "mandate not found",
    created_at: now - 40 * MIN,
  },
  {
    mandate_id: m(1).mandate_id,
    agent_id: m(1).agent_id,
    request_amount: 18000,
    category: "electronics",
    decision: "step_up_requested",
    reason: "would exceed max_cumulative, human approval requested",
    created_at: now - 35 * MIN,
  },
  {
    mandate_id: m(1).mandate_id,
    agent_id: m(1).agent_id,
    request_amount: 18000,
    category: "electronics",
    decision: "step_up_approved",
    reason: "human approved step-up request",
    created_at: now - 30 * MIN,
  },
  {
    mandate_id: m(1).mandate_id,
    agent_id: m(1).agent_id,
    request_amount: 18000,
    category: "electronics",
    decision: "order_created",
    reason: "Razorpay order created after step-up approval",
    order_id: "order_demo_2",
    created_at: now - 29 * MIN,
  },
  {
    mandate_id: m(2).mandate_id,
    agent_id: m(2).agent_id,
    request_amount: 300,
    category: "subscriptions",
    decision: "step_up_denied",
    reason: "human denied step-up request",
    created_at: now - 20 * MIN,
  },
  {
    mandate_id: m(2).mandate_id,
    agent_id: m(2).agent_id,
    request_amount: 300,
    category: "subscriptions",
    decision: "step_up_timeout",
    reason: "step-up request unanswered past timeout, auto-denied",
    created_at: now - 15 * MIN,
  },
  {
    mandate_id: m(0).mandate_id,
    agent_id: m(0).agent_id,
    request_amount: 200,
    category: "food_delivery",
    decision: "pass",
    reason: "within bounds",
    created_at: now - 10 * MIN,
  },
  {
    mandate_id: m(0).mandate_id,
    agent_id: m(0).agent_id,
    request_amount: 200,
    category: "food_delivery",
    decision: "payment_failed",
    reason: "Razorpay test-mode payment declined",
    order_id: "order_demo_3",
    payment_id: "pay_demo_failed_1",
    created_at: now - 9 * MIN,
  },
];

for (const entry of entries) {
  const saved = auditStore.writeEntry(entry);
  console.log(`Seeded audit entry #${saved.id}: ${saved.decision} (${saved.reason})`);
}
