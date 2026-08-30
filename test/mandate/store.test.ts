import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { createMandateStore, MandateStore } from "../../src/mandate/store";
import { MandateNotFoundError, MandateIntegrityError } from "../../src/mandate/errors";
import { CreateMandateInput } from "../../src/mandate/types";
import { verify } from "../../src/mandate/signer";

const DAY_MS = 24 * 60 * 60 * 1000;

function validInput(overrides: Partial<CreateMandateInput> = {}): CreateMandateInput {
  return {
    user_id: "user-1",
    agent_id: "agent-1",
    agent_public_key: "pubkey-abc",
    category: ["groceries"],
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 7 * 24 * 60 * 60,
    expires_at: Date.now() + 30 * DAY_MS,
    ...overrides,
  };
}

describe("MandateStore", () => {
  let db: Database.Database;
  let store: MandateStore;

  beforeEach(() => {
    db = buildTestDb();
    store = createMandateStore(db, TEST_SIGNING_KEY);
  });

  describe("create", () => {
    it("persists a mandate with status=active and returns a mandate_id and signature", () => {
      const mandate = store.create(validInput());
      expect(mandate.mandate_id).toBeTruthy();
      expect(mandate.signature).toBeTruthy();
      expect(mandate.status).toBe("active");
    });

    it("produces a signature that verify() confirms against the stored fields", () => {
      const mandate = store.create(validInput());
      const row = db
        .prepare("SELECT * FROM mandates WHERE mandate_id = ?")
        .get(mandate.mandate_id) as Record<string, unknown>;
      const payload = {
        mandate_id: row.mandate_id,
        user_id: row.user_id,
        agent_id: row.agent_id,
        agent_public_key: row.agent_public_key,
        category: JSON.parse(row.category as string),
        max_per_transaction: row.max_per_transaction,
        max_cumulative: row.max_cumulative,
        rolling_window_seconds: row.rolling_window_seconds,
        expires_at: row.expires_at,
        created_at: row.created_at,
      };
      expect(verify(payload, row.signature as string, TEST_SIGNING_KEY)).toBe(true);
    });
  });

  describe("getById", () => {
    it("reports status=active for a freshly created, unexpired, unrevoked mandate", () => {
      const mandate = store.create(validInput());
      const fetched = store.getById(mandate.mandate_id);
      expect(fetched.status).toBe("active");
    });

    it("reports status=expired once now is past expires_at, without ever writing expired into the status column", () => {
      const created = store.create(validInput({ expires_at: Date.now() + 1000 }));
      const future = Date.now() + 2000;
      const fetched = store.getById(created.mandate_id, future);
      expect(fetched.status).toBe("expired");

      const row = db
        .prepare("SELECT status FROM mandates WHERE mandate_id = ?")
        .get(created.mandate_id) as { status: string };
      expect(row.status).toBe("active");
    });

    it("reports status=revoked after revoke(), even when the mandate is also past its expires_at", () => {
      const created = store.create(validInput({ expires_at: Date.now() + 1000 }));
      store.revoke(created.mandate_id);
      const fetched = store.getById(created.mandate_id, Date.now() + 2000);
      expect(fetched.status).toBe("revoked");
    });

    it("throws MandateIntegrityError when a stored field is altered via a raw SQL UPDATE outside the store's API", () => {
      const created = store.create(validInput());
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(
        999999,
        created.mandate_id
      );
      expect(() => store.getById(created.mandate_id)).toThrow(MandateIntegrityError);
    });

    it("throws MandateNotFoundError on an unknown mandate_id", () => {
      expect(() => store.getById("does-not-exist")).toThrow(MandateNotFoundError);
    });
  });

  describe("revoke", () => {
    it("sets status=revoked", () => {
      const created = store.create(validInput());
      store.revoke(created.mandate_id);
      expect(store.getById(created.mandate_id).status).toBe("revoked");
    });

    it("is idempotent — calling it twice does not error and leaves status=revoked", () => {
      const created = store.create(validInput());
      store.revoke(created.mandate_id);
      expect(() => store.revoke(created.mandate_id)).not.toThrow();
      expect(store.getById(created.mandate_id).status).toBe("revoked");
    });

    it("throws MandateNotFoundError on an unknown mandate_id", () => {
      expect(() => store.revoke("does-not-exist")).toThrow(MandateNotFoundError);
    });

    it("does not itself perform a signature check, so it still succeeds against an already-tampered row", () => {
      const created = store.create(validInput());
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(
        999999,
        created.mandate_id
      );
      expect(() => store.revoke(created.mandate_id)).not.toThrow();
      const row = db
        .prepare("SELECT status FROM mandates WHERE mandate_id = ?")
        .get(created.mandate_id) as { status: string };
      expect(row.status).toBe("revoked");
    });

    it("does not invalidate the mandate's original signature", () => {
      const created = store.create(validInput());
      store.revoke(created.mandate_id);
      db.prepare("UPDATE mandates SET status = 'active' WHERE mandate_id = ?").run(
        created.mandate_id
      );
      expect(() => store.getById(created.mandate_id)).not.toThrow(MandateIntegrityError);
    });
  });

  describe("incrementSpend / getCumulativeSpend", () => {
    it("appends a spend_events row rather than mutating a running counter", () => {
      const created = store.create(validInput());
      store.incrementSpend(created.mandate_id, 100);
      const count = db
        .prepare("SELECT COUNT(*) as c FROM spend_events WHERE mandate_id = ?")
        .get(created.mandate_id) as { c: number };
      expect(count.c).toBe(1);
    });

    it("calling incrementSpend twice makes getCumulativeSpend reflect the sum of both amounts", () => {
      const created = store.create(validInput());
      store.incrementSpend(created.mandate_id, 100);
      store.incrementSpend(created.mandate_id, 50);
      expect(store.getCumulativeSpend(created.mandate_id)).toBe(150);
    });

    it("excludes spend events older than rolling_window_seconds from the given now", () => {
      const windowSeconds = 60;
      const created = store.create(validInput({ rolling_window_seconds: windowSeconds }));
      const now = Date.now();
      store.incrementSpend(created.mandate_id, 100, now - (windowSeconds + 10) * 1000);
      store.incrementSpend(created.mandate_id, 50, now);
      expect(store.getCumulativeSpend(created.mandate_id, now)).toBe(50);
    });

    it("includes a spend event exactly at the window boundary", () => {
      const windowSeconds = 60;
      const created = store.create(validInput({ rolling_window_seconds: windowSeconds }));
      const now = Date.now();
      store.incrementSpend(created.mandate_id, 100, now - windowSeconds * 1000);
      expect(store.getCumulativeSpend(created.mandate_id, now)).toBe(100);
    });

    it("returns 0 for a mandate with no spend events", () => {
      const created = store.create(validInput());
      expect(store.getCumulativeSpend(created.mandate_id)).toBe(0);
    });

    it("getCumulativeSpend throws MandateIntegrityError when the mandate row has been tampered with", () => {
      const created = store.create(validInput());
      db.prepare("UPDATE mandates SET rolling_window_seconds = ? WHERE mandate_id = ?").run(
        1,
        created.mandate_id
      );
      expect(() => store.getCumulativeSpend(created.mandate_id)).toThrow(MandateIntegrityError);
    });

    it("incrementSpend throws MandateIntegrityError when the mandate row has been tampered with", () => {
      const created = store.create(validInput());
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(
        999999,
        created.mandate_id
      );
      expect(() => store.incrementSpend(created.mandate_id, 100)).toThrow(MandateIntegrityError);
    });

    it("incrementSpend rejects a zero or negative amount", () => {
      const created = store.create(validInput());
      expect(() => store.incrementSpend(created.mandate_id, 0)).toThrow(/amount/);
      expect(() => store.incrementSpend(created.mandate_id, -50)).toThrow(/amount/);
    });

    it("incrementSpend rejects a non-finite amount", () => {
      const created = store.create(validInput());
      expect(() => store.incrementSpend(created.mandate_id, NaN)).toThrow(/amount/);
      expect(() => store.incrementSpend(created.mandate_id, Infinity)).toThrow(/amount/);
    });
  });

  describe("listByUser", () => {
    it("returns only mandates belonging to the given user_id", () => {
      store.create(validInput({ user_id: "user-a" }));
      store.create(validInput({ user_id: "user-b" }));
      const results = store.listByUser("user-a");
      expect(results).toHaveLength(1);
      expect(results[0].user_id).toBe("user-a");
    });

    it("reports correct per-item computed status for one active, one expired, and one revoked mandate", () => {
      const now = Date.now();
      store.create(validInput({ user_id: "user-x", expires_at: now + DAY_MS }));
      store.create(validInput({ user_id: "user-x", expires_at: now + 1000 }));
      const revokedOne = store.create(validInput({ user_id: "user-x" }));
      store.revoke(revokedOne.mandate_id);

      const results = store.listByUser("user-x", now + 2000);
      const statuses = results.map((m) => m.status).sort();
      expect(statuses).toEqual(["active", "expired", "revoked"]);
    });

    it("returns an empty array for a user with no mandates", () => {
      expect(store.listByUser("nobody")).toEqual([]);
    });

    it("throws MandateIntegrityError when a mandate belonging to the user has been tampered with", () => {
      const created = store.create(validInput({ user_id: "user-tampered" }));
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(
        999999,
        created.mandate_id
      );
      expect(() => store.listByUser("user-tampered")).toThrow(MandateIntegrityError);
    });
  });
});
