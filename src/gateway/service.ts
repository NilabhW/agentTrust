import { randomUUID } from "node:crypto";
import { MandateStore } from "../mandate/store";
import { MandateIntegrityError, MandateNotFoundError } from "../mandate/errors";
import { Mandate } from "../mandate/types";
import { AuditStore } from "../audit/store";
import { Decision } from "../audit/types";
import { PendingApprovalStore } from "./store";
import { ReplayGuard } from "./replay";
import { evaluateBounds } from "./bounds";
import { verifyAgentSignature, AgentSignedPayload } from "./agent-signature";
import { validateVerifyRequestBody } from "./validation";
import { GatewayDecisionResult, PendingApproval } from "./types";
import { RazorpayClient } from "../razorpay/client";
import { OrdersStore } from "../razorpay/orders-store";

export interface ResolveOutcome {
  httpStatus: number;
  approval: PendingApproval;
}

interface OrderAttempt {
  mandateId: string;
  agentId: string;
  amount: number;
  category: string;
}

export class GatewayService {
  constructor(
    private readonly mandateStore: MandateStore,
    private readonly auditStore: AuditStore,
    private readonly pendingApprovalStore: PendingApprovalStore,
    private readonly replayGuard: ReplayGuard,
    private readonly razorpayClient?: RazorpayClient,
    private readonly ordersStore?: OrdersStore
  ) {}

  async verify(input: unknown, now: number = Date.now()): Promise<GatewayDecisionResult> {
    const body = validateVerifyRequestBody(input);

    const mandate = (() => {
      try {
        return this.mandateStore.getById(body.mandate_id, now);
      } catch (err) {
        if (err instanceof MandateNotFoundError) return null;
        if (err instanceof MandateIntegrityError) {
          this.writeAudit({
            mandateId: body.mandate_id,
            agentId: null,
            amount: body.amount,
            category: body.category,
            decision: "hard_fail",
            reason: "mandate integrity check failed",
            now,
          });
        }
        throw err;
      }
    })();

    if (!mandate) {
      this.writeAudit({
        mandateId: body.mandate_id,
        agentId: null,
        amount: body.amount,
        category: body.category,
        decision: "hard_fail",
        reason: "mandate not found",
        now,
      });
      return { decision: "hard_fail", reason: "mandate not found", order_id: null };
    }

    const signaturePayload: AgentSignedPayload = {
      mandate_id: body.mandate_id,
      amount: body.amount,
      category: body.category,
      item_description: body.item_description,
      timestamp: body.timestamp,
      nonce: body.nonce,
    };

    if (!verifyAgentSignature(signaturePayload, body.agent_signature, mandate.agent_public_key)) {
      this.writeAudit({
        mandateId: mandate.mandate_id,
        agentId: mandate.agent_id,
        amount: body.amount,
        category: body.category,
        decision: "hard_fail",
        reason: "invalid signature",
        now,
      });
      return { decision: "hard_fail", reason: "invalid signature", order_id: null };
    }

    const replayResult = this.replayGuard.check(mandate.mandate_id, body.nonce, body.timestamp, now);
    if (!replayResult.ok) {
      this.writeAudit({
        mandateId: mandate.mandate_id,
        agentId: mandate.agent_id,
        amount: body.amount,
        category: body.category,
        decision: "hard_fail",
        reason: replayResult.reason!,
        now,
      });
      return { decision: "hard_fail", reason: replayResult.reason!, order_id: null };
    }

    const bounds = evaluateBounds({ amount: body.amount, category: body.category, mandate });

    if (bounds.decision === "pass") {
      // SAFETY-LOAD-BEARING ORDERING: evaluateBounds() reads mandate.current_cumulative_spend,
      // and incrementSpend() below is the next synchronous statement -- no `await` sits between
      // them, so better-sqlite3's synchronous API plus Node's single-threaded event loop makes
      // this check-then-increment atomic today. When Program 3 lands, its order-creation call
      // is EXACTLY where a Razorpay call would naturally slot in -- do not insert it between
      // this bounds check and incrementSpend without wrapping both in a transaction (or an
      // explicit reserve-then-confirm scheme), or concurrent requests could all read the same
      // pre-increment cumulative spend and all pass, bypassing max_cumulative entirely.
      this.mandateStore.incrementSpend(mandate.mandate_id, body.amount, now);
      this.writeAudit({
        mandateId: mandate.mandate_id,
        agentId: mandate.agent_id,
        amount: body.amount,
        category: body.category,
        decision: "pass",
        reason: bounds.reason,
        now,
      });
      const order_id = await this.tryCreateOrder(
        {
          mandateId: mandate.mandate_id,
          agentId: mandate.agent_id,
          amount: body.amount,
          category: body.category,
        },
        now
      );
      return { decision: "pass", reason: bounds.reason, order_id };
    }

    if (bounds.decision === "hard_fail") {
      this.writeAudit({
        mandateId: mandate.mandate_id,
        agentId: mandate.agent_id,
        amount: body.amount,
        category: body.category,
        decision: "hard_fail",
        reason: bounds.reason,
        now,
      });
      return { decision: "hard_fail", reason: bounds.reason, order_id: null };
    }

    const approval = this.pendingApprovalStore.create(
      {
        mandate_id: mandate.mandate_id,
        agent_id: mandate.agent_id,
        amount: body.amount,
        category: body.category,
        item_description: body.item_description,
      },
      now
    );
    this.writeAudit({
      mandateId: mandate.mandate_id,
      agentId: mandate.agent_id,
      amount: body.amount,
      category: body.category,
      decision: "step_up_requested",
      reason: bounds.reason,
      now,
    });
    return { decision: "step_up", reason: bounds.reason, order_id: null, pending_approval_id: approval.id };
  }

  async approveStepUp(id: string, now: number = Date.now()): Promise<ResolveOutcome> {
    // Read-only check first (materializes a timeout if the row has expired,
    // via the same exactly-once guard the store uses everywhere else).
    const current = this.pendingApprovalStore.getById(id, now);
    if (current.justTimedOut) {
      this.writeApprovalAudit(current.approval, "step_up_timeout", "step-up request unanswered past timeout, auto-denied", now);
      return { httpStatus: 409, approval: current.approval };
    }
    if (current.approval.status !== "pending") {
      return { httpStatus: 409, approval: current.approval };
    }

    // Re-check the mandate itself is still usable before granting the
    // approval: a step-up can sit pending for minutes, and revocation must
    // stop the money even mid-flight through this flow. If the mandate is no
    // longer valid, resolve the approval as a system-detected hard-fail
    // (never as "approved") rather than leaving it stuck pending forever.
    let mandate: Mandate;
    try {
      mandate = this.mandateStore.getById(current.approval.mandate_id, now);
    } catch (err) {
      if (err instanceof MandateIntegrityError) {
        this.writeApprovalAudit(current.approval, "hard_fail", "mandate integrity check failed", now);
      }
      throw err;
    }

    if (mandate.status !== "active") {
      const denyResult = this.pendingApprovalStore.deny(id, now);
      const reason = mandate.status === "revoked" ? "mandate revoked" : "mandate expired";
      this.writeApprovalAudit(denyResult.approval, "hard_fail", reason, now);
      return { httpStatus: 409, approval: denyResult.approval };
    }

    // Increment spend BEFORE flipping the approval to "approved": if this
    // throws (e.g. a concurrent tamper), the approval stays "pending" rather
    // than getting stuck "approved" with no spend ever recorded against it.
    try {
      this.mandateStore.incrementSpend(mandate.mandate_id, current.approval.amount, now);
    } catch (err) {
      if (err instanceof MandateIntegrityError) {
        this.writeApprovalAudit(current.approval, "hard_fail", "mandate integrity check failed", now);
      }
      throw err;
    }

    const result = this.pendingApprovalStore.approve(id, now);
    if (result.justTimedOut || result.alreadyResolved) {
      // Should be unreachable given the checks above (better-sqlite3 is
      // synchronous/single-threaded per process), but never double-write an
      // audit entry if this store call didn't actually flip anything.
      return { httpStatus: 409, approval: result.approval };
    }

    this.writeApprovalAudit(result.approval, "step_up_approved", "human approved step-up request", now);
    await this.tryCreateOrder(
      {
        mandateId: result.approval.mandate_id,
        agentId: result.approval.agent_id,
        amount: result.approval.amount,
        category: result.approval.category,
      },
      now
    );
    return { httpStatus: 200, approval: result.approval };
  }

  denyStepUp(id: string, now: number = Date.now()): ResolveOutcome {
    const result = this.pendingApprovalStore.deny(id, now);

    if (result.justTimedOut) {
      this.writeApprovalAudit(result.approval, "step_up_timeout", "step-up request unanswered past timeout, auto-denied", now);
      return { httpStatus: 409, approval: result.approval };
    }
    if (result.alreadyResolved) {
      return { httpStatus: 409, approval: result.approval };
    }

    this.writeApprovalAudit(result.approval, "step_up_denied", "human denied step-up request", now);
    return { httpStatus: 200, approval: result.approval };
  }

  listPendingApprovals(now: number = Date.now()): PendingApproval[] {
    const result = this.pendingApprovalStore.listPending(now);
    for (const approval of result.justTimedOut) {
      this.writeApprovalAudit(approval, "step_up_timeout", "step-up request unanswered past timeout, auto-denied", now);
    }
    return result.approvals;
  }

  // Called only after spend has already been incremented (pass / step-up
  // approved), per the safety-ordering established in Phase 3: Program 3's
  // call belongs after incrementSpend, never between the bounds check and
  // the increment. Consequence, documented in CLAUDE.md as an accepted
  // limitation: if create_order() itself fails here, the spend is already
  // committed against the mandate's cap even though no order exists.
  private async tryCreateOrder(attempt: OrderAttempt, now: number): Promise<string | null> {
    if (!this.razorpayClient || !this.ordersStore) return null;

    const receipt = randomUUID();
    const result = await this.razorpayClient.createOrder({
      mandate_id: attempt.mandateId,
      agent_id: attempt.agentId,
      amount: attempt.amount,
      category: attempt.category,
      receipt,
    });

    if (result.status === "failed") {
      this.writeAudit({
        mandateId: attempt.mandateId,
        agentId: attempt.agentId,
        amount: attempt.amount,
        category: attempt.category,
        decision: "payment_failed",
        reason: `order creation failed: ${result.raw_error}`,
        now,
      });
      return null;
    }

    this.ordersStore.create(
      {
        order_id: result.order_id,
        mandate_id: attempt.mandateId,
        agent_id: attempt.agentId,
        amount: attempt.amount,
        category: attempt.category,
        receipt,
      },
      now
    );

    this.writeAudit({
      mandateId: attempt.mandateId,
      agentId: attempt.agentId,
      amount: attempt.amount,
      category: attempt.category,
      decision: "order_created",
      reason: "Razorpay order created",
      now,
      orderId: result.order_id,
    });

    return result.order_id;
  }

  private writeApprovalAudit(
    approval: PendingApproval,
    decision: Decision,
    reason: string,
    now: number
  ): void {
    this.writeAudit({
      mandateId: approval.mandate_id,
      agentId: approval.agent_id,
      amount: approval.amount,
      category: approval.category,
      decision,
      reason,
      now,
    });
  }

  private writeAudit(input: {
    mandateId: string;
    agentId: string | null;
    amount: number;
    category: string;
    decision: Decision;
    reason: string;
    now: number;
    orderId?: string;
  }): void {
    this.auditStore.writeEntry({
      mandate_id: input.mandateId,
      agent_id: input.agentId,
      request_amount: input.amount,
      category: input.category,
      decision: input.decision,
      reason: input.reason,
      created_at: input.now,
      order_id: input.orderId ?? null,
    });
  }
}
