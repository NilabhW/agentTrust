import type Database from "better-sqlite3";
import { AuditValidationError } from "./errors";
import {
  DECISIONS,
  Decision,
  AuditLogEntry,
  ListAuditEntriesOptions,
  ListAuditEntriesResult,
  StoredAuditLogRow,
  WriteAuditEntryInput,
} from "./types";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function isValidDecision(value: unknown): value is Decision {
  return DECISIONS.includes(value as Decision);
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(limit, MAX_LIMIT));
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

export class AuditStore {
  constructor(private readonly db: Database.Database) {}

  writeEntry(input: WriteAuditEntryInput): AuditLogEntry {
    if (!isValidDecision(input.decision)) {
      throw new AuditValidationError(`decision must be one of: ${DECISIONS.join(", ")}`);
    }
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new AuditValidationError("reason is required and must be a non-empty string");
    }
    if (input.request_amount != null && (!Number.isFinite(input.request_amount) || input.request_amount <= 0)) {
      throw new AuditValidationError("request_amount must be a positive finite number when provided");
    }
    for (const [field, value] of Object.entries({
      mandate_id: input.mandate_id,
      agent_id: input.agent_id,
      category: input.category,
      order_id: input.order_id,
      payment_id: input.payment_id,
    })) {
      if (!isNullableString(value)) {
        throw new AuditValidationError(`${field} must be a string when provided`);
      }
    }

    const created_at = input.created_at ?? Date.now();
    const mandate_id = input.mandate_id ?? null;
    const agent_id = input.agent_id ?? null;
    const request_amount = input.request_amount ?? null;
    const category = input.category ?? null;
    const order_id = input.order_id ?? null;
    const payment_id = input.payment_id ?? null;

    const result = this.db
      .prepare(
        `INSERT INTO audit_log
          (created_at, mandate_id, agent_id, request_amount, category, decision, reason, order_id, payment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        created_at,
        mandate_id,
        agent_id,
        request_amount,
        category,
        input.decision,
        input.reason,
        order_id,
        payment_id
      );

    return {
      id: Number(result.lastInsertRowid),
      created_at,
      mandate_id,
      agent_id,
      request_amount,
      category,
      decision: input.decision,
      reason: input.reason,
      order_id,
      payment_id,
    };
  }

  list(options: ListAuditEntriesOptions = {}): ListAuditEntriesResult {
    const limit = clampLimit(options.limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.before_id !== undefined) {
      clauses.push("id < ?");
      params.push(options.before_id);
    }
    if (options.mandate_id !== undefined) {
      clauses.push("mandate_id = ?");
      params.push(options.mandate_id);
    }
    if (options.decision !== undefined) {
      clauses.push("decision = ?");
      params.push(options.decision);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit + 1) as StoredAuditLogRow[];

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;

    return {
      entries,
      next_before_id: hasMore ? entries[entries.length - 1].id : null,
    };
  }
}

export function createAuditStore(db: Database.Database): AuditStore {
  return new AuditStore(db);
}
