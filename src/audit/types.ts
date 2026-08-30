export const DECISIONS = [
  "pass",
  "hard_fail",
  "step_up_requested",
  "step_up_approved",
  "step_up_denied",
  "step_up_timeout",
  "order_created",
  "payment_failed",
] as const;

export type Decision = (typeof DECISIONS)[number];

export interface WriteAuditEntryInput {
  mandate_id?: string | null;
  agent_id?: string | null;
  request_amount?: number | null;
  category?: string | null;
  decision: Decision;
  reason: string;
  order_id?: string | null;
  payment_id?: string | null;
  created_at?: number;
}

export interface AuditLogEntry {
  id: number;
  created_at: number;
  mandate_id: string | null;
  agent_id: string | null;
  request_amount: number | null;
  category: string | null;
  decision: Decision;
  reason: string;
  order_id: string | null;
  payment_id: string | null;
}

export type StoredAuditLogRow = AuditLogEntry;

export interface ListAuditEntriesOptions {
  limit?: number;
  before_id?: number;
  mandate_id?: string;
  decision?: Decision;
}

export interface ListAuditEntriesResult {
  entries: AuditLogEntry[];
  next_before_id: number | null;
}
