import { describe, it, expect } from "vitest";
import { canonicalBytes } from "../../src/mandate/canonical";

describe("canonicalBytes", () => {
  it("produces identical serialized output regardless of input key order", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalBytes(a).equals(canonicalBytes(b))).toBe(true);
  });

  it("sorts nested object keys recursively", () => {
    const a = { outer: { z: 1, y: 2 }, top: 1 };
    const b = { top: 1, outer: { y: 2, z: 1 } };
    expect(canonicalBytes(a).equals(canonicalBytes(b))).toBe(true);
  });

  it("preserves array element order (arrays are not reordered)", () => {
    const a = { category: ["groceries", "electronics"] };
    const b = { category: ["electronics", "groceries"] };
    expect(canonicalBytes(a).equals(canonicalBytes(b))).toBe(false);
  });

  it("produces compact JSON with no inserted whitespace", () => {
    const bytes = canonicalBytes({ a: 1, b: [1, 2] });
    expect(bytes.toString("utf8")).toBe('{"a":1,"b":[1,2]}');
  });

  it("returns a UTF-8 Buffer, not a string", () => {
    const bytes = canonicalBytes({ a: 1 });
    expect(Buffer.isBuffer(bytes)).toBe(true);
  });

  it("does not silently drop an own __proto__-named property (prototype-pollution guard)", () => {
    // JSON.parse creates a genuine own property named "__proto__" (it does not
    // reassign the prototype) -- this is how an attacker-controlled request
    // body would actually carry this key.
    const payload = JSON.parse('{"a":1,"__proto__":"attacker-value"}');
    const output = canonicalBytes(payload).toString("utf8");
    const roundTripped = JSON.parse(output);
    expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
    expect(roundTripped.__proto__).toBe("attacker-value");
  });
});
