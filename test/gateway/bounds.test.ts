import { describe, it, expect } from "vitest";
import { evaluateBounds } from "../../src/gateway/bounds";
import { Mandate } from "../../src/mandate/types";

function validMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    mandate_id: "mandate-1",
    user_id: "user-1",
    agent_id: "agent-1",
    agent_public_key: "pubkey",
    category: ["groceries"],
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 86400,
    expires_at: Date.now() + 1000000,
    created_at: Date.now(),
    status: "active",
    signature: "sig",
    current_cumulative_spend: 0,
    ...overrides,
  };
}

describe("evaluateBounds", () => {
  it("passes when amount is within max_per_transaction, cumulative+amount within max_cumulative, and category in scope", () => {
    const result = evaluateBounds({ amount: 100, category: "groceries", mandate: validMandate() });
    expect(result.decision).toBe("pass");
  });

  it("passes at the exact max_per_transaction boundary (inclusive)", () => {
    const result = evaluateBounds({
      amount: 500,
      category: "groceries",
      mandate: validMandate({ max_per_transaction: 500 }),
    });
    expect(result.decision).toBe("pass");
  });

  it("passes at the exact max_cumulative boundary (inclusive)", () => {
    const result = evaluateBounds({
      amount: 500,
      category: "groceries",
      mandate: validMandate({ max_cumulative: 2000, current_cumulative_spend: 1500 }),
    });
    expect(result.decision).toBe("pass");
  });

  it("hard_fails with 'mandate revoked' regardless of amount/category validity", () => {
    const result = evaluateBounds({
      amount: 100,
      category: "groceries",
      mandate: validMandate({ status: "revoked" }),
    });
    expect(result).toEqual({ decision: "hard_fail", reason: "mandate revoked" });
  });

  it("hard_fails with 'mandate expired'", () => {
    const result = evaluateBounds({
      amount: 100,
      category: "groceries",
      mandate: validMandate({ status: "expired" }),
    });
    expect(result).toEqual({ decision: "hard_fail", reason: "mandate expired" });
  });

  it("hard_fails with 'category not in scope'", () => {
    const result = evaluateBounds({
      amount: 100,
      category: "electronics",
      mandate: validMandate({ category: ["groceries"] }),
    });
    expect(result).toEqual({ decision: "hard_fail", reason: "category not in scope" });
  });

  it("hard_fails with 'amount exceeds max_per_transaction'", () => {
    const result = evaluateBounds({
      amount: 501,
      category: "groceries",
      mandate: validMandate({ max_per_transaction: 500 }),
    });
    expect(result).toEqual({ decision: "hard_fail", reason: "amount exceeds max_per_transaction" });
  });

  it("triggers step_up with 'would exceed max_cumulative' when amount is within max_per_transaction", () => {
    const result = evaluateBounds({
      amount: 600,
      category: "groceries",
      mandate: validMandate({ max_per_transaction: 1000, max_cumulative: 1000, current_cumulative_spend: 500 }),
    });
    expect(result).toEqual({ decision: "step_up", reason: "would exceed max_cumulative" });
  });

  it("precedence: revoked status wins over an also-invalid category", () => {
    const result = evaluateBounds({
      amount: 100,
      category: "electronics",
      mandate: validMandate({ status: "revoked", category: ["groceries"] }),
    });
    expect(result.reason).toBe("mandate revoked");
  });

  it("precedence: category-not-in-scope wins over also-over-max_per_transaction", () => {
    const result = evaluateBounds({
      amount: 9999,
      category: "electronics",
      mandate: validMandate({ category: ["groceries"], max_per_transaction: 500 }),
    });
    expect(result.reason).toBe("category not in scope");
  });

  it("precedence: over-max_per_transaction (hard_fail) wins over also-over-max_cumulative (step_up)", () => {
    const result = evaluateBounds({
      amount: 9999,
      category: "groceries",
      mandate: validMandate({ max_per_transaction: 500, max_cumulative: 1000, current_cumulative_spend: 900 }),
    });
    expect(result).toEqual({ decision: "hard_fail", reason: "amount exceeds max_per_transaction" });
  });

  it("is deterministic and never reads the wall clock", () => {
    const mandate = validMandate();
    const a = evaluateBounds({ amount: 100, category: "groceries", mandate });
    const b = evaluateBounds({ amount: 100, category: "groceries", mandate });
    expect(a).toEqual(b);
  });
});
