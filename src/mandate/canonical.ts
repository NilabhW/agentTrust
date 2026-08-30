function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    // A null-prototype target is required here: a plain `{}` literal inherits
    // Object.prototype's `__proto__` accessor, so assigning to a key literally
    // named "__proto__" would silently reassign the prototype (or no-op)
    // instead of creating a normal own property, dropping that field from the
    // signed bytes. See test/mandate/canonical.test.ts's prototype-pollution case.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as object).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalBytes(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(canonicalize(payload)), "utf8");
}
