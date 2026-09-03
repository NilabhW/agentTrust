import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DECISIONS } from "../audit/types";

// SQLite can't ALTER a CHECK constraint, and CREATE TABLE IF NOT EXISTS is a
// no-op on a table that already exists -- so widening audit_log.decision's
// enum (as every new decision-producing phase of this project has needed
// to) silently does nothing on a pre-existing database. Every write of the
// new decision value then throws a CHECK-constraint error at the exact
// moment it's needed, discovered here after it happened for real on a dev
// database: a fire-and-forget caller (the Program 6 upsell trigger) simply
// swallowed it, leaving a live, actionable row with zero audit trail. This
// rebuild step detects and fixes that, using DECISIONS (audit/types.ts) as
// the single source of truth, so it stays correct as future decisions are
// added without needing to be touched again.
function auditLogNeedsWidening(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
    .get() as { sql: string } | undefined;
  if (!row) return false; // doesn't exist yet -- the fresh CREATE TABLE below will have the full constraint
  return !DECISIONS.every((decision) => row.sql.includes(`'${decision}'`));
}

function widenAuditLogDecisionCheck(db: Database.Database): void {
  const decisionList = DECISIONS.map((decision) => `'${decision}'`).join(",");
  db.exec(`
    DROP TRIGGER IF EXISTS trg_audit_log_no_update;
    DROP TRIGGER IF EXISTS trg_audit_log_no_delete;
    ALTER TABLE audit_log RENAME TO audit_log_old;
    CREATE TABLE audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at      INTEGER NOT NULL,
      mandate_id      TEXT,
      agent_id        TEXT,
      request_amount  REAL CHECK (request_amount IS NULL OR request_amount > 0),
      category        TEXT,
      decision        TEXT NOT NULL CHECK (decision IN (${decisionList})),
      reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
      order_id        TEXT,
      payment_id      TEXT
    );
    INSERT INTO audit_log SELECT * FROM audit_log_old;
    DROP TABLE audit_log_old;
  `);
}

export function migrate(db: Database.Database): void {
  if (auditLogNeedsWidening(db)) {
    widenAuditLogDecisionCheck(db);
  }
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);
}
