export const CATEGORIES = [
  "groceries",
  "food_delivery",
  "subscriptions",
  "electronics",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type MandateStatus = "active" | "revoked" | "expired";

export interface CreateMandateInput {
  user_id: string;
  agent_id: string;
  agent_public_key: string;
  category: Category[];
  max_per_transaction: number;
  max_cumulative: number;
  rolling_window_seconds: number;
  expires_at: number;
}

export interface StoredMandateRow {
  mandate_id: string;
  user_id: string;
  agent_id: string;
  agent_public_key: string;
  category: string;
  max_per_transaction: number;
  max_cumulative: number;
  rolling_window_seconds: number;
  expires_at: number;
  created_at: number;
  status: "active" | "revoked";
  signature: string;
}

export interface Mandate {
  mandate_id: string;
  user_id: string;
  agent_id: string;
  agent_public_key: string;
  category: Category[];
  max_per_transaction: number;
  max_cumulative: number;
  rolling_window_seconds: number;
  expires_at: number;
  created_at: number;
  status: MandateStatus;
  signature: string;
  current_cumulative_spend: number;
}
