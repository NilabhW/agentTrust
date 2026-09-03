import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { createMandateStore, MandateStore } from "../../src/mandate/store";
import { CreateMandateInput } from "../../src/mandate/types";
import { createUpsellStore, UpsellStore } from "../../src/upsell/store";
import { UpsellNotFoundError } from "../../src/upsell/errors";

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

describe("UpsellStore", () => {
  let db: Database.Database;
  let mandateStore: MandateStore;
  let store: UpsellStore;
  let mandateId: string;

  beforeEach(() => {
    db = buildTestDb();
    mandateStore = createMandateStore(db, TEST_SIGNING_KEY);
    store = createUpsellStore(db);
    mandateId = mandateStore.create(validMandateInput()).mandate_id;
  });

  function validInput(overrides: Partial<Parameters<UpsellStore["create"]>[0]> = {}) {
    return {
      mandate_id: mandateId,
      agent_id: "agent-1",
      origin_order_id: "order_abc",
      item_id: "gro-eggs-30",
      item_name: "Eggs, tray of 30",
      category: "groceries",
      amount: 210,
      reason: "pairs well with your recent order",
      ...overrides,
    };
  }

  it("creates an upsell suggestion with status suggested", () => {
    const upsell = store.create(validInput());
    expect(upsell.status).toBe("suggested");
    expect(upsell.resolved_at).toBeNull();
    expect(upsell.item_id).toBe("gro-eggs-30");
  });

  it("fetches a created upsell by id", () => {
    const created = store.create(validInput());
    expect(store.getById(created.id)?.item_name).toBe("Eggs, tray of 30");
  });

  it("returns undefined for an unknown id", () => {
    expect(store.getById("does-not-exist")).toBeUndefined();
  });

  it("lists only suggested (unresolved) upsells", () => {
    const a = store.create(validInput());
    const b = store.create(validInput({ item_id: "gro-rice-5kg" }));
    store.accept(a.id);

    const pending = store.listPending();
    expect(pending.map((u) => u.id)).toEqual([b.id]);
  });

  it("accepts a suggestion", () => {
    const created = store.create(validInput());
    const result = store.accept(created.id);
    expect(result.alreadyResolved).toBe(false);
    expect(result.upsell.status).toBe("accepted");
    expect(result.upsell.resolved_at).not.toBeNull();
  });

  it("declines a suggestion", () => {
    const created = store.create(validInput());
    const result = store.decline(created.id);
    expect(result.alreadyResolved).toBe(false);
    expect(result.upsell.status).toBe("declined");
  });

  it("is idempotent when accepting an already-resolved suggestion twice", () => {
    const created = store.create(validInput());
    store.accept(created.id);
    const second = store.accept(created.id);
    expect(second.alreadyResolved).toBe(true);
    expect(second.upsell.status).toBe("accepted");
  });

  it("does not let a decline override a prior accept", () => {
    const created = store.create(validInput());
    store.accept(created.id);
    const result = store.decline(created.id);
    expect(result.alreadyResolved).toBe(true);
    expect(result.upsell.status).toBe("accepted");
  });

  it("throws UpsellNotFoundError when resolving an unknown id", () => {
    expect(() => store.accept("does-not-exist")).toThrow(UpsellNotFoundError);
    expect(() => store.decline("does-not-exist")).toThrow(UpsellNotFoundError);
  });

  describe("metrics", () => {
    it("reflects zero state with no upsells", () => {
      expect(store.metrics()).toEqual({ suggested: 0, accepted: 0, declined: 0, amount_accepted_inr: 0 });
    });

    it("counts suggested/accepted/declined and sums accepted amounts", () => {
      const a = store.create(validInput({ amount: 210 }));
      const b = store.create(validInput({ amount: 350, item_id: "gro-fruit-basket" }));
      const c = store.create(validInput({ amount: 720, item_id: "gro-milk-12" }));
      store.accept(a.id);
      store.accept(b.id);
      store.decline(c.id);

      expect(store.metrics()).toEqual({ suggested: 3, accepted: 2, declined: 1, amount_accepted_inr: 560 });
    });
  });
});
