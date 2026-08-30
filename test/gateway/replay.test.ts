import { describe, it, expect } from "vitest";
import { createReplayGuard } from "../../src/gateway/replay";

const SKEW_MS = 120_000;

describe("ReplayGuard", () => {
  it("accepts a fresh nonce within the skew window", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    expect(guard.check("mandate-1", "nonce-1", now, now).ok).toBe(true);
  });

  it("rejects a nonce already seen for the same mandate", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    guard.check("mandate-1", "nonce-1", now, now);
    const result = guard.check("mandate-1", "nonce-1", now, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("duplicate request");
  });

  it("rejects a timestamp older than the skew window", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    const result = guard.check("mandate-1", "nonce-1", now - SKEW_MS - 1, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale request");
  });

  it("rejects a timestamp in the future beyond the skew window", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    const result = guard.check("mandate-1", "nonce-1", now + SKEW_MS + 1, now);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale request");
  });

  it("accepts a timestamp exactly at the skew boundary", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    expect(guard.check("mandate-1", "nonce-1", now - SKEW_MS, now).ok).toBe(true);
    expect(guard.check("mandate-1", "nonce-2", now + SKEW_MS, now).ok).toBe(true);
  });

  it("prunes nonces older than 2x the skew window so the cache doesn't grow unboundedly", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    guard.check("mandate-1", "nonce-1", now, now);
    const muchLater = now + SKEW_MS * 2 + 1;
    const result = guard.check("mandate-1", "nonce-1", muchLater, muchLater);
    expect(result.ok).toBe(true);
  });

  it("does not allow a replay at the exact far edge of the timestamp window (regression: off-by-one in pruning)", () => {
    const guard = createReplayGuard(SKEW_MS);
    const T = Date.now();
    // First submission at the near edge of the window for timestamp T.
    expect(guard.check("mandate-1", "nonce-1", T, T - SKEW_MS).ok).toBe(true);
    // A replay of the SAME nonce, arriving at the far edge (now = T + skewMs)
    // -- still within skew of T, so it must be caught by the duplicate check,
    // not slip through because the cache pruned it at exactly this instant.
    const result = guard.check("mandate-1", "nonce-1", T, T + SKEW_MS);
    expect(result).toEqual({ ok: false, reason: "duplicate request" });
  });

  it("does not consume a nonce slot when rejected for staleness", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    guard.check("mandate-1", "nonce-1", now - SKEW_MS - 1, now);
    const retried = guard.check("mandate-1", "nonce-1", now, now);
    expect(retried.ok).toBe(true);
  });

  it("does not collide on the same nonce string used under two different mandate ids", () => {
    const guard = createReplayGuard(SKEW_MS);
    const now = Date.now();
    guard.check("mandate-1", "shared-nonce", now, now);
    const result = guard.check("mandate-2", "shared-nonce", now, now);
    expect(result.ok).toBe(true);
  });
});
