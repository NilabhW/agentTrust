import { Category, Mandate } from "../mandate/types";
import { GatewayDecisionKind } from "./types";

export interface EvaluateBoundsInput {
  amount: number;
  category: Category;
  mandate: Mandate;
}

export interface EvaluateBoundsResult {
  decision: GatewayDecisionKind;
  reason: string;
}

export function evaluateBounds({ amount, category, mandate }: EvaluateBoundsInput): EvaluateBoundsResult {
  if (mandate.status === "revoked") {
    return { decision: "hard_fail", reason: "mandate revoked" };
  }
  if (mandate.status === "expired") {
    return { decision: "hard_fail", reason: "mandate expired" };
  }
  if (!mandate.category.includes(category)) {
    return { decision: "hard_fail", reason: "category not in scope" };
  }
  if (amount > mandate.max_per_transaction) {
    return { decision: "hard_fail", reason: "amount exceeds max_per_transaction" };
  }
  if (mandate.current_cumulative_spend + amount > mandate.max_cumulative) {
    return { decision: "step_up", reason: "would exceed max_cumulative" };
  }
  return { decision: "pass", reason: "within bounds" };
}
