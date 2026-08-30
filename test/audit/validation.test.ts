import { describe, it, expect } from "vitest";
import { parseListAuditQuery } from "../../src/audit/validation";
import { AuditValidationError } from "../../src/audit/errors";

describe("parseListAuditQuery", () => {
  it("returns default limit=50 and no cursor/filters for an empty query", () => {
    const result = parseListAuditQuery({});
    expect(result).toEqual({ limit: 50 });
  });

  it("parses a valid numeric limit string", () => {
    const result = parseListAuditQuery({ limit: "10" });
    expect(result.limit).toBe(10);
  });

  it("throws AuditValidationError for a non-numeric limit", () => {
    expect(() => parseListAuditQuery({ limit: "abc" })).toThrow(AuditValidationError);
  });

  it("throws AuditValidationError for a zero or negative limit", () => {
    expect(() => parseListAuditQuery({ limit: "0" })).toThrow(AuditValidationError);
    expect(() => parseListAuditQuery({ limit: "-5" })).toThrow(AuditValidationError);
  });

  it("parses a valid numeric before_id string", () => {
    const result = parseListAuditQuery({ before_id: "42" });
    expect(result.before_id).toBe(42);
  });

  it("throws AuditValidationError for a non-numeric before_id", () => {
    expect(() => parseListAuditQuery({ before_id: "abc" })).toThrow(AuditValidationError);
  });

  it("passes through a valid mandate_id filter unchanged", () => {
    const result = parseListAuditQuery({ mandate_id: "mandate-123" });
    expect(result.mandate_id).toBe("mandate-123");
  });

  it("accepts a decision filter that matches one of the 8 valid enum values", () => {
    const result = parseListAuditQuery({ decision: "hard_fail" });
    expect(result.decision).toBe("hard_fail");
  });

  it("throws AuditValidationError for a decision filter outside the fixed enum", () => {
    expect(() => parseListAuditQuery({ decision: "bogus" })).toThrow(AuditValidationError);
  });
});
