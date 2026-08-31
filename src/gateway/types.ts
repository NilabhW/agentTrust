import { Category } from "../mandate/types";

export interface VerifyRequestBody {
  mandate_id: string;
  agent_signature: string;
  amount: number;
  category: Category;
  item_description: string;
  timestamp: number;
  nonce: string;
}

export type GatewayDecisionKind = "pass" | "hard_fail" | "step_up";

export interface GatewayDecisionResult {
  decision: GatewayDecisionKind;
  reason: string;
  // Populated with a real Razorpay order id when Program 3 is configured
  // (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET set) and create_order() succeeds
  // after a pass decision; null otherwise (Razorpay not configured, a
  // hard_fail/step_up decision, or a create_order() failure -- see the
  // payment_failed audit entry for that last case).
  order_id: string | null;
  pending_approval_id?: string;
}

export type PendingApprovalStatus = "pending" | "approved" | "denied";

export interface PendingApproval {
  id: string;
  mandate_id: string;
  agent_id: string;
  amount: number;
  category: string;
  item_description: string;
  requested_at: number;
  expires_at: number;
  status: PendingApprovalStatus;
  resolved_at: number | null;
  timed_out: boolean;
}

export interface StoredPendingApprovalRow {
  id: string;
  mandate_id: string;
  agent_id: string;
  amount: number;
  category: string;
  item_description: string;
  requested_at: number;
  expires_at: number;
  status: PendingApprovalStatus;
  resolved_at: number | null;
  timed_out: number;
}

export interface CreatePendingApprovalInput {
  mandate_id: string;
  agent_id: string;
  amount: number;
  category: string;
  item_description: string;
}

export interface MaterializedApproval {
  approval: PendingApproval;
  justTimedOut: boolean;
}

export interface ResolveApprovalResult extends MaterializedApproval {
  alreadyResolved: boolean;
}

export interface ListPendingResult {
  approvals: PendingApproval[];
  justTimedOut: PendingApproval[];
}
