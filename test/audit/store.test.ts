import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { buildTestDb } from "../setup";
import { createAuditStore, AuditStore } from "../../src/audit/store";
import { AuditValidationError } from "../../src/audit/errors";
import { DECISIONS, WriteAuditEntryInput } from "../../src/audit/types";

function validEntry(overrides: Partial<WriteAuditEntryInput> = {}): WriteAuditEntryInput {
  return {
    mandate_id: "mandate-1",
    agent_id: "agent-1",
    request_amount: 100,
    category: "groceries",
    decision: "pass",
    reason: "within bounds",
    order_id: null,
    payment_id: null,
    ...overrides,
  };
}

describe("AuditStore", () => {
  let db: Database.Database;
  let store: AuditStore;

  beforeEach(() => {
    db = buildTestDb();
    store = createAuditStore(db);
  });

  describe("writeEntry", () => {
    it("persists all fields correctly for a fully-populated entry", () => {
      const entry = store.writeEntry(
        validEntry({ order_id: "order_1", payment_id: "pay_1" })
      );
      expect(entry.mandate_id).toBe("mandate-1");
      expect(entry.agent_id).toBe("agent-1");
      expect(entry.request_amount).toBe(100);
      expect(entry.category).toBe("groceries");
      expect(entry.decision).toBe("pass");
      expect(entry.reason).toBe("within bounds");
      expect(entry.order_id).toBe("order_1");
      expect(entry.payment_id).toBe("pay_1");
    });

    it("returns an AuditLogEntry with an autoincrement id and created_at set to now by default", () => {
      const before = Date.now();
      const entry = store.writeEntry(validEntry());
      const after = Date.now();
      expect(typeof entry.id).toBe("number");
      expect(entry.created_at).toBeGreaterThanOrEqual(before);
      expect(entry.created_at).toBeLessThanOrEqual(after);
    });

    it("accepts an explicit created_at override for deterministic tests", () => {
      const entry = store.writeEntry(validEntry({ created_at: 12345 }));
      expect(entry.created_at).toBe(12345);
    });

    it("persists an entry with nullable fields explicitly set to null", () => {
      const entry = store.writeEntry({
        mandate_id: null,
        agent_id: null,
        request_amount: null,
        category: null,
        decision: "hard_fail",
        reason: "mandate not found",
        order_id: null,
        payment_id: null,
      });
      expect(entry.mandate_id).toBeNull();
      expect(entry.agent_id).toBeNull();
      expect(entry.request_amount).toBeNull();
      expect(entry.category).toBeNull();
      expect(entry.order_id).toBeNull();
      expect(entry.payment_id).toBeNull();
    });

    it("persists an entry when nullable fields are simply omitted, storing them as null", () => {
      const entry = store.writeEntry({ decision: "hard_fail", reason: "mandate not found" });
      expect(entry.mandate_id).toBeNull();
      expect(entry.agent_id).toBeNull();
      expect(entry.request_amount).toBeNull();
      expect(entry.category).toBeNull();
      expect(entry.order_id).toBeNull();
      expect(entry.payment_id).toBeNull();
    });

    it("accepts all 8 valid decision values and persists each verbatim", () => {
      for (const decision of DECISIONS) {
        const entry = store.writeEntry(validEntry({ decision }));
        expect(entry.decision).toBe(decision);
      }
    });

    it("throws AuditValidationError when decision is not one of the 8 valid enum values", () => {
      expect(() =>
        store.writeEntry(validEntry({ decision: "bogus" as WriteAuditEntryInput["decision"] }))
      ).toThrow(AuditValidationError);
    });

    it("throws AuditValidationError when reason is missing or an empty/whitespace-only string", () => {
      expect(() => store.writeEntry(validEntry({ reason: "" }))).toThrow(AuditValidationError);
      expect(() => store.writeEntry(validEntry({ reason: "   " }))).toThrow(AuditValidationError);
      expect(() =>
        store.writeEntry({ decision: "pass" } as WriteAuditEntryInput)
      ).toThrow(AuditValidationError);
    });

    it("throws AuditValidationError when request_amount is provided but not a finite number", () => {
      expect(() => store.writeEntry(validEntry({ request_amount: NaN }))).toThrow(
        AuditValidationError
      );
      expect(() => store.writeEntry(validEntry({ request_amount: Infinity }))).toThrow(
        AuditValidationError
      );
    });

    it("throws AuditValidationError when request_amount is zero or negative", () => {
      expect(() => store.writeEntry(validEntry({ request_amount: 0 }))).toThrow(
        AuditValidationError
      );
      expect(() => store.writeEntry(validEntry({ request_amount: -50 }))).toThrow(
        AuditValidationError
      );
    });

    it("throws AuditValidationError when mandate_id, agent_id, category, order_id, or payment_id is provided but not a string", () => {
      expect(() =>
        store.writeEntry(validEntry({ mandate_id: 123 as unknown as string }))
      ).toThrow(AuditValidationError);
      expect(() =>
        store.writeEntry(validEntry({ agent_id: {} as unknown as string }))
      ).toThrow(AuditValidationError);
      expect(() =>
        store.writeEntry(validEntry({ category: ["groceries"] as unknown as string }))
      ).toThrow(AuditValidationError);
      expect(() =>
        store.writeEntry(validEntry({ order_id: 1 as unknown as string }))
      ).toThrow(AuditValidationError);
      expect(() =>
        store.writeEntry(validEntry({ payment_id: [] as unknown as string }))
      ).toThrow(AuditValidationError);
    });
  });

  describe("append-only enforcement", () => {
    it("throws when attempting a raw SQL UPDATE against an existing audit_log row", () => {
      const entry = store.writeEntry(validEntry());
      expect(() =>
        db.prepare("UPDATE audit_log SET reason = ? WHERE id = ?").run("changed", entry.id)
      ).toThrow();
    });

    it("throws when attempting a raw SQL DELETE against an existing audit_log row", () => {
      const entry = store.writeEntry(validEntry());
      expect(() => db.prepare("DELETE FROM audit_log WHERE id = ?").run(entry.id)).toThrow();
    });

    it("the decision CHECK constraint rejects an invalid value even via a raw SQL INSERT that bypasses the store", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO audit_log (created_at, decision, reason) VALUES (?, 'bogus', 'x')"
          )
          .run(Date.now())
      ).toThrow();
    });

    it("the reason CHECK constraint rejects an empty string even via a raw SQL INSERT that bypasses the store", () => {
      expect(() =>
        db
          .prepare("INSERT INTO audit_log (created_at, decision, reason) VALUES (?, 'pass', '')")
          .run(Date.now())
      ).toThrow();
    });
  });

  describe("list", () => {
    it("returns entries newest-first (descending by id) by default", () => {
      const a = store.writeEntry(validEntry());
      const b = store.writeEntry(validEntry());
      const c = store.writeEntry(validEntry());
      const result = store.list();
      expect(result.entries.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    });

    it("applies the default limit (50) when no limit is specified", () => {
      for (let i = 0; i < 60; i++) store.writeEntry(validEntry());
      const result = store.list();
      expect(result.entries).toHaveLength(50);
    });

    it("respects an explicit limit smaller than the default", () => {
      for (let i = 0; i < 10; i++) store.writeEntry(validEntry());
      const result = store.list({ limit: 3 });
      expect(result.entries).toHaveLength(3);
    });

    it("clamps an explicit limit above the maximum down to the max limit (200)", () => {
      for (let i = 0; i < 5; i++) store.writeEntry(validEntry());
      const result = store.list({ limit: 10000 });
      expect(result.entries).toHaveLength(5);
    });

    it("clamps a zero or negative limit up to a minimum of 1, never returning an unbounded result set", () => {
      for (let i = 0; i < 5; i++) store.writeEntry(validEntry());
      expect(store.list({ limit: 0 }).entries).toHaveLength(1);
      expect(store.list({ limit: -100 }).entries).toHaveLength(1);
    });

    it("falls back to the default limit for a non-finite limit value", () => {
      for (let i = 0; i < 5; i++) store.writeEntry(validEntry());
      expect(store.list({ limit: NaN }).entries).toHaveLength(5);
      expect(store.list({ limit: Infinity }).entries).toHaveLength(5);
    });

    it("before_id returns only entries strictly older than the given cursor id", () => {
      const a = store.writeEntry(validEntry());
      const b = store.writeEntry(validEntry());
      store.writeEntry(validEntry());
      const result = store.list({ before_id: b.id + 1 });
      expect(result.entries.map((e) => e.id)).not.toContain(b.id + 1);
      const strictlyOlder = store.list({ before_id: b.id });
      expect(strictlyOlder.entries.map((e) => e.id)).toEqual([a.id]);
    });

    it("next_before_id is set to the oldest returned entry's id when more entries remain", () => {
      const a = store.writeEntry(validEntry());
      const b = store.writeEntry(validEntry());
      store.writeEntry(validEntry());
      const result = store.list({ limit: 2 });
      expect(result.next_before_id).toBe(b.id);
      expect(result.entries.map((e) => e.id)).not.toContain(a.id);
    });

    it("next_before_id is null when the returned page is the last page", () => {
      store.writeEntry(validEntry());
      const result = store.list({ limit: 50 });
      expect(result.next_before_id).toBeNull();
    });

    it("returns an empty entries array and next_before_id=null when the log is empty", () => {
      const result = store.list();
      expect(result.entries).toEqual([]);
      expect(result.next_before_id).toBeNull();
    });

    it("filters by mandate_id when provided", () => {
      store.writeEntry(validEntry({ mandate_id: "mandate-a" }));
      store.writeEntry(validEntry({ mandate_id: "mandate-b" }));
      const result = store.list({ mandate_id: "mandate-a" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].mandate_id).toBe("mandate-a");
    });

    it("filters by decision when provided", () => {
      store.writeEntry(validEntry({ decision: "pass" }));
      store.writeEntry(validEntry({ decision: "hard_fail" }));
      const result = store.list({ decision: "hard_fail" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].decision).toBe("hard_fail");
    });

    it("combines mandate_id and decision filters together", () => {
      store.writeEntry(validEntry({ mandate_id: "mandate-a", decision: "pass" }));
      store.writeEntry(validEntry({ mandate_id: "mandate-a", decision: "hard_fail" }));
      store.writeEntry(validEntry({ mandate_id: "mandate-b", decision: "hard_fail" }));
      const result = store.list({ mandate_id: "mandate-a", decision: "hard_fail" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].mandate_id).toBe("mandate-a");
      expect(result.entries[0].decision).toBe("hard_fail");
    });

    it("returns entries in a stable order even when multiple entries share the same created_at millisecond", () => {
      const now = Date.now();
      const a = store.writeEntry(validEntry({ created_at: now }));
      const b = store.writeEntry(validEntry({ created_at: now }));
      const c = store.writeEntry(validEntry({ created_at: now }));
      const result = store.list();
      expect(result.entries.map((e) => e.id)).toEqual([c.id, b.id, a.id]);
    });
  });
});
