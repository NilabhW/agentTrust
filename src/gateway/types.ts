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
  // Always null in this phase — Program 3 (Razorpay) doesn't exist yet, so a
  // "pass" decision never creates an order. This is exactly where Program 3
  // plugs in later: populate order_id after a successful order_created call.
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
