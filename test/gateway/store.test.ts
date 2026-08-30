import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { createMandateStore, MandateStore } from "../../src/mandate/store";
import { CreateMandateInput } from "../../src/mandate/types";
import { createPendingApprovalStore, PendingApprovalStore } from "../../src/gateway/store";
import { PendingApprovalNotFoundError } from "../../src/gateway/errors";

const TIMEOUT_MS = 300_000;

function validMandateInput(overrides: Partial<CreateMandateInput> = {}): CreateMandateInput {
  return {
    user_id: "user-1",
    agent_id: "agent-1",
    agent_public_key: "pubkey-abc",
    category: ["groceries"],
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 86400,
    expires_at: Date.now() + 1000000,
    ...overrides,
  };
}

describe("PendingApprovalStore", () => {
  let db: Database.Database;
  let mandateStore: MandateStore;
  let store: PendingApprovalStore;
  let mandateId: string;

  beforeEach(() => {
    db = buildTestDb();
    mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    store = createPendingApprovalStore(db, TIMEOUT_MS);
    mandateId = mandateStore.create(validMandateInput()).mandate_id;
  });

  function validInput(overrides: Partial<Parameters<PendingApprovalStore["create"]>[0]> = {}) {
    return {
      mandate_id: mandateId,
      agent_id: "agent-1",
      amount: 100,
      category: "groceries",
      item_description: "weekly groceries",
      ...overrides,
    };
  }

  describe("create", () => {
    it("persists status=pending with expires_at = requested_at + timeoutMs", () => {
      const now = Date.now();
      const approval = store.create(validInput(), now);
      expect(approval.status).toBe("pending");
      expect(approval.requested_at).toBe(now);
      expect(approval.expires_at).toBe(now + TIMEOUT_MS);
    });
  });

  describe("getById", () => {
    it("returns justTimedOut=false for a still-pending, unexpired row", () => {
      const created = store.create(validInput());
      const result = store.getById(created.id);
      expect(result.justTimedOut).toBe(false);
      expect(result.approval.status).toBe("pending");
    });

    it("throws PendingApprovalNotFoundError for an unknown id", () => {
      expect(() => store.getById("does-not-exist")).toThrow(PendingApprovalNotFoundError);
    });

    it("materializes an expired pending row on first read: status->denied, timed_out->true, justTimedOut=true", () => {
      const now = Date.now();
      const created = store.create(validInput(), now);
      const later = now + TIMEOUT_MS + 1;
      const result = store.getById(created.id, later);
      expect(result.justTimedOut).toBe(true);
      expect(result.approval.status).toBe("denied");
      expect(result.approval.timed_out).toBe(true);
    });

    it("does not re-materialize on a second read of an already-flipped row", () => {
      const now = Date.now();
      const created = store.create(validInput(), now);
      const later = now + TIMEOUT_MS + 1;
      store.getById(created.id, later);
      const secondRead = store.getById(created.id, later + 1000);
      expect(secondRead.justTimedOut).toBe(false);
      expect(secondRead.approval.status).toBe("denied");
    });
  });

  describe("listPending", () => {
    it("excludes rows materialized-as-timed-out during this same call", () => {
      const now = Date.now();
      store.create(validInput(), now);
      const later = now + TIMEOUT_MS + 1;
      const result = store.listPending(later);
      expect(result.approvals).toHaveLength(0);
      expect(result.justTimedOut).toHaveLength(1);
    });

    it("reports justTimedOut only for rows that flip during this call, not previously-flipped ones", () => {
      const now = Date.now();
      const created = store.create(validInput(), now);
      const later = now + TIMEOUT_MS + 1;
      store.getById(created.id, later);
      const result = store.listPending(later + 1000);
      expect(result.justTimedOut).toHaveLength(0);
      expect(result.approvals).toHaveLength(0);
    });

    it("includes still-pending, unexpired rows", () => {
      store.create(validInput());
      const result = store.listPending();
      expect(result.approvals).toHaveLength(1);
      expect(result.justTimedOut).toHaveLength(0);
    });
  });

  describe("approve", () => {
    it("sets status=approved and resolved_at on a still-pending row", () => {
      const created = store.create(validInput());
      const now = Date.now();
      const result = store.approve(created.id, now);
      expect(result.approval.status).toBe("approved");
      expect(result.approval.resolved_at).toBe(now);
      expect(result.alreadyResolved).toBe(false);
      expect(result.justTimedOut).toBe(false);
    });

    it("auto-denies via timeout instead of approving when the row is already expired", () => {
      const now = Date.now();
      const created = store.create(validInput(), now);
      const later = now + TIMEOUT_MS + 1;
      const result = store.approve(created.id, later);
      expect(result.justTimedOut).toBe(true);
      expect(result.approval.status).toBe("denied");
      expect(result.approval.timed_out).toBe(true);
    });

    it("reports alreadyResolved=true on a second approve call, without changing resolved_at", () => {
      const created = store.create(validInput());
      const first = store.approve(created.id, Date.now());
      const second = store.approve(created.id, Date.now() + 1000);
      expect(second.alreadyResolved).toBe(true);
      expect(second.approval.resolved_at).toBe(first.approval.resolved_at);
    });

    it("throws PendingApprovalNotFoundError for an unknown id", () => {
      expect(() => store.approve("does-not-exist")).toThrow(PendingApprovalNotFoundError);
    });
  });

  describe("deny", () => {
    it("sets status=denied and resolved_at on a still-pending row, timed_out stays false", () => {
      const created = store.create(validInput());
      const now = Date.now();
      const result = store.deny(created.id, now);
      expect(result.approval.status).toBe("denied");
      expect(result.approval.resolved_at).toBe(now);
      expect(result.approval.timed_out).toBe(false);
      expect(result.alreadyResolved).toBe(false);
    });

    it("reports alreadyResolved=true when the row was already approved", () => {
      const created = store.create(validInput());
      store.approve(created.id, Date.now());
      const result = store.deny(created.id, Date.now() + 1000);
      expect(result.alreadyResolved).toBe(true);
      expect(result.approval.status).toBe("approved");
    });

    it("throws PendingApprovalNotFoundError for an unknown id", () => {
      expect(() => store.deny("does-not-exist")).toThrow(PendingApprovalNotFoundError);
    });
  });
});
