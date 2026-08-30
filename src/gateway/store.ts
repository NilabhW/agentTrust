import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { PendingApprovalNotFoundError } from "./errors";
import {
  CreatePendingApprovalInput,
  ListPendingResult,
  MaterializedApproval,
  PendingApproval,
  ResolveApprovalResult,
  StoredPendingApprovalRow,
} from "./types";

function toApproval(row: StoredPendingApprovalRow): PendingApproval {
  return {
    id: row.id,
    mandate_id: row.mandate_id,
    agent_id: row.agent_id,
    amount: row.amount,
    category: row.category,
    item_description: row.item_description,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    status: row.status,
    resolved_at: row.resolved_at,
    timed_out: row.timed_out === 1,
  };
}

export class PendingApprovalStore {
  constructor(
    private readonly db: Database.Database,
    private readonly timeoutMs: number = 300_000
  ) {}

  create(input: CreatePendingApprovalInput, now: number = Date.now()): PendingApproval {
    const id = randomUUID();
    const expiresAt = now + this.timeoutMs;
    this.db
      .prepare(
        `INSERT INTO pending_approvals
          (id, mandate_id, agent_id, amount, category, item_description, requested_at, expires_at, status, timed_out)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)`
      )
      .run(
        id,
        input.mandate_id,
        input.agent_id,
        input.amount,
        input.category,
        input.item_description,
        now,
        expiresAt
      );
    return this.toApprovalById(id);
  }

  getById(id: string, now: number = Date.now()): MaterializedApproval {
    const row = this.fetchRow(id);
    if (!row) throw new PendingApprovalNotFoundError(id);
    return this.materializeIfExpired(row, now);
  }

  listPending(now: number = Date.now()): ListPendingResult {
    const rows = this.db
      .prepare("SELECT * FROM pending_approvals WHERE status = 'pending'")
      .all() as StoredPendingApprovalRow[];

    const approvals: PendingApproval[] = [];
    const justTimedOut: PendingApproval[] = [];

    for (const row of rows) {
      const result = this.materializeIfExpired(row, now);
      if (result.justTimedOut) {
        justTimedOut.push(result.approval);
      } else {
        approvals.push(result.approval);
      }
    }

    return { approvals, justTimedOut };
  }

  approve(id: string, now: number = Date.now()): ResolveApprovalResult {
    return this.resolve(id, "approved", now);
  }

  deny(id: string, now: number = Date.now()): ResolveApprovalResult {
    return this.resolve(id, "denied", now);
  }

  private resolve(id: string, targetStatus: "approved" | "denied", now: number): ResolveApprovalResult {
    const row = this.fetchRow(id);
    if (!row) throw new PendingApprovalNotFoundError(id);

    const materialized = this.materializeIfExpired(row, now);
    if (materialized.justTimedOut) {
      return { ...materialized, alreadyResolved: false };
    }
    if (materialized.approval.status !== "pending") {
      return { ...materialized, alreadyResolved: true };
    }

    this.db
      .prepare("UPDATE pending_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(targetStatus, now, id);

    return {
      approval: this.toApprovalById(id),
      justTimedOut: false,
      alreadyResolved: false,
    };
  }

  private materializeIfExpired(row: StoredPendingApprovalRow, now: number): MaterializedApproval {
    if (row.status !== "pending" || now <= row.expires_at) {
      return { approval: toApproval(row), justTimedOut: false };
    }

    const result = this.db
      .prepare(
        "UPDATE pending_approvals SET status = 'denied', timed_out = 1, resolved_at = ? WHERE id = ? AND status = 'pending'"
      )
      .run(now, row.id);

    return { approval: this.toApprovalById(row.id), justTimedOut: result.changes === 1 };
  }

  private fetchRow(id: string): StoredPendingApprovalRow | undefined {
    return this.db
      .prepare("SELECT * FROM pending_approvals WHERE id = ?")
      .get(id) as StoredPendingApprovalRow | undefined;
  }

  private toApprovalById(id: string): PendingApproval {
    return toApproval(this.fetchRow(id)!);
  }
}

export function createPendingApprovalStore(db: Database.Database, timeoutMs?: number): PendingApprovalStore {
  return new PendingApprovalStore(db, timeoutMs);
}
