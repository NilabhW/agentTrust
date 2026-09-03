import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { UpsellNotFoundError } from "./errors";
import { CreateUpsellInput, ResolveUpsellResult, StoredUpsellRow, UpsellMetrics, UpsellRecord } from "./types";

function toUpsell(row: StoredUpsellRow): UpsellRecord {
  return { ...row };
}

export class UpsellStore {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateUpsellInput, now: number = Date.now()): UpsellRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO upsells
          (id, mandate_id, agent_id, origin_order_id, item_id, item_name, category, amount, reason, status, suggested_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'suggested', ?, NULL)`
      )
      .run(
        id,
        input.mandate_id,
        input.agent_id,
        input.origin_order_id ?? null,
        input.item_id,
        input.item_name,
        input.category,
        input.amount,
        input.reason,
        now
      );
    return this.getById(id)!;
  }

  getById(id: string): UpsellRecord | undefined {
    const row = this.db.prepare("SELECT * FROM upsells WHERE id = ?").get(id) as StoredUpsellRow | undefined;
    return row ? toUpsell(row) : undefined;
  }

  listPending(): UpsellRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM upsells WHERE status = 'suggested' ORDER BY suggested_at DESC")
      .all() as StoredUpsellRow[];
    return rows.map(toUpsell);
  }

  accept(id: string, now: number = Date.now()): ResolveUpsellResult {
    return this.resolve(id, "accepted", now);
  }

  decline(id: string, now: number = Date.now()): ResolveUpsellResult {
    return this.resolve(id, "declined", now);
  }

  // `suggested` is a lifetime total (COUNT(*), not filtered to
  // status='suggested') by design -- this is a conversion funnel
  // (buildspec: "suggested vs. accepted, INR added"), so it's the
  // denominator every accepted/declined suggestion is a subset of, not a
  // live count of currently-pending rows (that's listPending().length).
  metrics(): UpsellMetrics {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS suggested,
           SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
           SUM(CASE WHEN status = 'declined' THEN 1 ELSE 0 END) AS declined,
           SUM(CASE WHEN status = 'accepted' THEN amount ELSE 0 END) AS amount_accepted_inr
         FROM upsells`
      )
      .get() as { suggested: number; accepted: number | null; declined: number | null; amount_accepted_inr: number | null };

    return {
      suggested: row.suggested,
      accepted: row.accepted ?? 0,
      declined: row.declined ?? 0,
      amount_accepted_inr: row.amount_accepted_inr ?? 0,
    };
  }

  private resolve(id: string, targetStatus: "accepted" | "declined", now: number): ResolveUpsellResult {
    const current = this.getById(id);
    if (!current) throw new UpsellNotFoundError(id);

    const result = this.db
      .prepare("UPDATE upsells SET status = ?, resolved_at = ? WHERE id = ? AND status = 'suggested'")
      .run(targetStatus, now, id);

    if (result.changes !== 1) {
      return { upsell: this.getById(id)!, alreadyResolved: true };
    }
    return { upsell: this.getById(id)!, alreadyResolved: false };
  }
}

export function createUpsellStore(db: Database.Database): UpsellStore {
  return new UpsellStore(db);
}
