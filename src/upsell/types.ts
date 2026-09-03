import { Mandate } from "../mandate/types";

export interface Headroom {
  maxPerTransaction: number;
  remainingCumulative: number;
}

export interface SuggestUpsellInput {
  mandate: Mandate;
  originOrderId?: string | null;
  purchasedItemName?: string;
}

export type UpsellStatus = "suggested" | "accepted" | "declined";

export interface UpsellRecord {
  id: string;
  mandate_id: string;
  agent_id: string;
  origin_order_id: string | null;
  item_id: string;
  item_name: string;
  category: string;
  amount: number;
  reason: string;
  status: UpsellStatus;
  suggested_at: number;
  resolved_at: number | null;
}

export type StoredUpsellRow = UpsellRecord;

export interface CreateUpsellInput {
  mandate_id: string;
  agent_id: string;
  origin_order_id?: string | null;
  item_id: string;
  item_name: string;
  category: string;
  amount: number;
  reason: string;
}

export interface ResolveUpsellResult {
  upsell: UpsellRecord;
  alreadyResolved: boolean;
}

export interface UpsellMetrics {
  suggested: number;
  accepted: number;
  declined: number;
  amount_accepted_inr: number;
}
