import { describe, it, expect } from "vitest";
import { calculateHeadroom, filterCandidates } from "../../src/upsell/headroom";

describe("calculateHeadroom", () => {
  it("computes remaining cumulative headroom", () => {
    const result = calculateHeadroom({ max_per_transaction: 1500, max_cumulative: 10000, current_cumulative_spend: 4000 });
    expect(result).toEqual({ maxPerTransaction: 1500, remainingCumulative: 6000 });
  });

  it("never returns a negative remaining cumulative amount", () => {
    const result = calculateHeadroom({ max_per_transaction: 1500, max_cumulative: 10000, current_cumulative_spend: 12000 });
    expect(result.remainingCumulative).toBe(0);
  });

  it("returns zero remaining when spend exactly equals the cap", () => {
    const result = calculateHeadroom({ max_per_transaction: 1500, max_cumulative: 10000, current_cumulative_spend: 10000 });
    expect(result.remainingCumulative).toBe(0);
  });
});

describe("filterCandidates", () => {
  it("returns only items within both category scope and remaining headroom", () => {
    const result = filterCandidates({
      allowedCategories: ["groceries"],
      headroom: { maxPerTransaction: 1000, remainingCumulative: 1000 },
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((item) => item.category === "groceries")).toBe(true);
    expect(result.every((item) => item.price_inr <= 1000)).toBe(true);
  });

  it("excludes items outside the allowed categories even if affordable", () => {
    const result = filterCandidates({
      allowedCategories: ["groceries"],
      headroom: { maxPerTransaction: 100000, remainingCumulative: 100000 },
    });
    expect(result.every((item) => item.category === "groceries")).toBe(true);
  });

  it("uses the tighter of max-per-transaction and remaining-cumulative as the affordability cap", () => {
    const result = filterCandidates({
      allowedCategories: ["groceries", "food_delivery", "subscriptions", "electronics"],
      headroom: { maxPerTransaction: 100000, remainingCumulative: 100 },
    });
    expect(result.every((item) => item.price_inr <= 100)).toBe(true);
  });

  it("returns an empty list when headroom is exhausted", () => {
    const result = filterCandidates({
      allowedCategories: ["groceries"],
      headroom: { maxPerTransaction: 1500, remainingCumulative: 0 },
    });
    expect(result).toEqual([]);
  });

  it("returns an empty list when no allowed categories are given", () => {
    const result = filterCandidates({
      allowedCategories: [],
      headroom: { maxPerTransaction: 1500, remainingCumulative: 1500 },
    });
    expect(result).toEqual([]);
  });
});
