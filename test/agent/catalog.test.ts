import { describe, it, expect } from "vitest";
import { CATALOG, getCatalog, findCatalogItem } from "../../src/agent/catalog";
import { CATEGORIES } from "../../src/mandate/types";

describe("catalog", () => {
  it("has at least 15 items", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(15);
  });

  it("every item has a category from the fixed enum", () => {
    for (const item of CATALOG) {
      expect(CATEGORIES).toContain(item.category);
    }
  });

  it("every item has a positive price", () => {
    for (const item of CATALOG) {
      expect(item.price_inr).toBeGreaterThan(0);
    }
  });

  it("every item id is unique", () => {
    const ids = CATALOG.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every category at least once", () => {
    for (const category of CATEGORIES) {
      expect(CATALOG.some((item) => item.category === category)).toBe(true);
    }
  });

  it("has at least one item priced well above a typical per-transaction cap, for the hard-fail demo goal", () => {
    expect(CATALOG.some((item) => item.price_inr > 10000)).toBe(true);
  });

  describe("getCatalog", () => {
    it("returns the full catalog when no category is given", () => {
      expect(getCatalog()).toHaveLength(CATALOG.length);
    });

    it("filters by category", () => {
      const result = getCatalog("groceries");
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((item) => item.category === "groceries")).toBe(true);
    });
  });

  describe("findCatalogItem", () => {
    it("finds a known item by id", () => {
      expect(findCatalogItem("gro-rice-5kg")?.name).toBe("Basmati rice, 5kg");
    });

    it("returns undefined for an unknown id", () => {
      expect(findCatalogItem("does-not-exist")).toBeUndefined();
    });
  });
});
