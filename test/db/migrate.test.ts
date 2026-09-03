import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/db/migrate";
import { DECISIONS } from "../../src/audit/types";

// Reproduces the exact bug the security-reviewer found: a database created
// before a new decision value was added to DECISIONS/schema.sql had its
// audit_log CHECK constraint frozen at the old enum, because
// `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table -- so every
// new-decision audit write on a pre-existing database silently threw and
// was swallowed by the fire-and-forget upsell trigger, leaving live,
// actionable rows (upsells, resolved pending_approvals) with zero audit
// trail. migrate() must widen an old CHECK constraint in place.
function createPreProgram6Db(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE mandates (
      mandate_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      agent_public_key TEXT NOT NULL, category TEXT NOT NULL, max_per_transaction REAL NOT NULL,
      max_cumulative REAL NOT NULL, rolling_window_seconds INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', signature TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      mandate_id TEXT,
      agent_id TEXT,
      request_amount REAL CHECK (request_amount IS NULL OR request_amount > 0),
      category TEXT,
      decision TEXT NOT NULL CHECK (decision IN (
        'pass','hard_fail','step_up_requested','step_up_approved',
        'step_up_denied','step_up_timeout','order_created',
        'payment_captured','payment_failed'
      )),
      reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      order_id TEXT,
      payment_id TEXT
    );
    CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted'); END;
    CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not permitted'); END;
  `);
  db.prepare(
    `INSERT INTO audit_log (created_at, mandate_id, agent_id, request_amount, category, decision, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), "mandate-1", "agent-1", 100, "groceries", "pass", "within bounds");
  return db;
}

describe("migrate() against a pre-existing database", () => {
  it("widens an old audit_log CHECK constraint to accept every current decision value", () => {
    const db = createPreProgram6Db();

    migrate(db);

    for (const decision of DECISIONS) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO audit_log (created_at, mandate_id, agent_id, request_amount, category, decision, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(Date.now(), "mandate-1", "agent-1", 100, "groceries", decision, "test entry")
      ).not.toThrow();
    }
  });

  it("preserves pre-existing rows across the widening rebuild", () => {
    const db = createPreProgram6Db();

    migrate(db);

    const rows = db.prepare("SELECT * FROM audit_log WHERE decision = 'pass'").all() as { reason: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("within bounds");
  });

  it("keeps the append-only triggers working after the rebuild", () => {
    const db = createPreProgram6Db();
    migrate(db);

    const row = db.prepare("SELECT id FROM audit_log LIMIT 1").get() as { id: number };
    expect(() => db.prepare("UPDATE audit_log SET reason = 'tampered' WHERE id = ?").run(row.id)).toThrow(
      /append-only/
    );
    expect(() => db.prepare("DELETE FROM audit_log WHERE id = ?").run(row.id)).toThrow(/append-only/);
  });

  it("is a no-op (does not rebuild) when the schema is already current", () => {
    const db = new Database(":memory:");
    migrate(db);
    migrate(db); // second call should not error or duplicate anything

    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='audit_log'").get() as {
      sql: string;
    };
    for (const decision of DECISIONS) {
      expect(row.sql).toContain(`'${decision}'`);
    }
  });

  it("still creates a brand-new database correctly (fresh-install path unaffected)", () => {
    const db = new Database(":memory:");
    migrate(db);

    for (const decision of DECISIONS) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO audit_log (created_at, mandate_id, agent_id, request_amount, category, decision, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(Date.now(), "mandate-1", "agent-1", 100, "groceries", decision, "test entry")
      ).not.toThrow();
    }
  });
});
