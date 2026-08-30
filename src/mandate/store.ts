import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sign, verify } from "./signer";
import { MandateIntegrityError, MandateNotFoundError, ValidationError } from "./errors";
import { Category, CreateMandateInput, Mandate, MandateStatus, StoredMandateRow } from "./types";

function signablePayload(row: {
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
}) {
  return {
    mandate_id: row.mandate_id,
    user_id: row.user_id,
    agent_id: row.agent_id,
    agent_public_key: row.agent_public_key,
    category: row.category,
    max_per_transaction: row.max_per_transaction,
    max_cumulative: row.max_cumulative,
    rolling_window_seconds: row.rolling_window_seconds,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

function computeStatus(row: StoredMandateRow, now: number): MandateStatus {
  if (row.status === "revoked") return "revoked";
  if (now > row.expires_at) return "expired";
  return "active";
}

export class MandateStore {
  constructor(
    private readonly db: Database.Database,
    private readonly signingKey: string
  ) {}

  create(input: CreateMandateInput, now: number = Date.now()): Mandate {
    const mandateId = randomUUID();
    const category = [...new Set(input.category)].sort();
    const payload = signablePayload({
      mandate_id: mandateId,
      user_id: input.user_id,
      agent_id: input.agent_id,
      agent_public_key: input.agent_public_key,
      category,
      max_per_transaction: input.max_per_transaction,
      max_cumulative: input.max_cumulative,
      rolling_window_seconds: input.rolling_window_seconds,
      expires_at: input.expires_at,
      created_at: now,
    });
    const signature = sign(payload, this.signingKey);

    this.db
      .prepare(
        `INSERT INTO mandates
          (mandate_id, user_id, agent_id, agent_public_key, category, max_per_transaction,
           max_cumulative, rolling_window_seconds, expires_at, created_at, status, signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
      )
      .run(
        mandateId,
        input.user_id,
        input.agent_id,
        input.agent_public_key,
        JSON.stringify(category),
        input.max_per_transaction,
        input.max_cumulative,
        input.rolling_window_seconds,
        input.expires_at,
        now,
        signature
      );

    return {
      mandate_id: mandateId,
      user_id: input.user_id,
      agent_id: input.agent_id,
      agent_public_key: input.agent_public_key,
      category: category as Category[],
      max_per_transaction: input.max_per_transaction,
      max_cumulative: input.max_cumulative,
      rolling_window_seconds: input.rolling_window_seconds,
      expires_at: input.expires_at,
      created_at: now,
      status: "active",
      signature,
      current_cumulative_spend: 0,
    };
  }

  revoke(mandateId: string): void {
    const row = this.fetchRow(mandateId);
    if (!row) throw new MandateNotFoundError(mandateId);
    this.db.prepare("UPDATE mandates SET status = 'revoked' WHERE mandate_id = ?").run(mandateId);
  }

  getById(mandateId: string, now: number = Date.now()): Mandate {
    const row = this.fetchVerifiedRow(mandateId);
    return this.toMandate(row, JSON.parse(row.category) as Category[], now);
  }

  listByUser(userId: string, now: number = Date.now()): Mandate[] {
    const rows = this.db
      .prepare("SELECT * FROM mandates WHERE user_id = ?")
      .all(userId) as StoredMandateRow[];
    return rows.map((row) => {
      this.verifyRowOrThrow(row);
      return this.toMandate(row, JSON.parse(row.category) as Category[], now);
    });
  }

  incrementSpend(mandateId: string, amount: number, now: number = Date.now()): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ValidationError("amount must be a positive finite number");
    }
    this.fetchVerifiedRow(mandateId);
    this.db
      .prepare("INSERT INTO spend_events (mandate_id, amount, occurred_at) VALUES (?, ?, ?)")
      .run(mandateId, amount, now);
  }

  getCumulativeSpend(mandateId: string, now: number = Date.now()): number {
    const row = this.fetchVerifiedRow(mandateId);
    return this.sumSpend(mandateId, row.rolling_window_seconds, now);
  }

  private verifyRowOrThrow(row: StoredMandateRow): void {
    const category = JSON.parse(row.category) as Category[];
    const payload = signablePayload({ ...row, category });
    if (!verify(payload, row.signature, this.signingKey)) {
      throw new MandateIntegrityError(row.mandate_id);
    }
  }

  private fetchVerifiedRow(mandateId: string): StoredMandateRow {
    const row = this.fetchRow(mandateId);
    if (!row) throw new MandateNotFoundError(mandateId);
    this.verifyRowOrThrow(row);
    return row;
  }

  private sumSpend(mandateId: string, rollingWindowSeconds: number, now: number): number {
    const windowStart = now - rollingWindowSeconds * 1000;
    const result = this.db
      .prepare(
        "SELECT COALESCE(SUM(amount), 0) as total FROM spend_events WHERE mandate_id = ? AND occurred_at >= ?"
      )
      .get(mandateId, windowStart) as { total: number };
    return result.total;
  }

  private fetchRow(mandateId: string): StoredMandateRow | undefined {
    return this.db
      .prepare("SELECT * FROM mandates WHERE mandate_id = ?")
      .get(mandateId) as StoredMandateRow | undefined;
  }

  private toMandate(row: StoredMandateRow, category: Category[], now: number): Mandate {
    return {
      mandate_id: row.mandate_id,
      user_id: row.user_id,
      agent_id: row.agent_id,
      agent_public_key: row.agent_public_key,
      category,
      max_per_transaction: row.max_per_transaction,
      max_cumulative: row.max_cumulative,
      rolling_window_seconds: row.rolling_window_seconds,
      expires_at: row.expires_at,
      created_at: row.created_at,
      status: computeStatus(row, now),
      signature: row.signature,
      current_cumulative_spend: this.sumSpend(row.mandate_id, row.rolling_window_seconds, now),
    };
  }
}

export function createMandateStore(db: Database.Database, signingKey: string): MandateStore {
  return new MandateStore(db, signingKey);
}
