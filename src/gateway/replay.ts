export interface ReplayCheckResult {
  ok: boolean;
  reason?: "stale request" | "duplicate request";
}

export class ReplayGuard {
  private readonly seenNonces = new Map<string, number>();

  constructor(private readonly skewMs: number = 120_000) {}

  check(mandateId: string, nonce: string, timestamp: number, now: number = Date.now()): ReplayCheckResult {
    this.prune(now);

    if (Math.abs(now - timestamp) > this.skewMs) {
      return { ok: false, reason: "stale request" };
    }

    const key = `${mandateId}:${nonce}`;
    if (this.seenNonces.has(key)) {
      return { ok: false, reason: "duplicate request" };
    }

    this.seenNonces.set(key, now + this.skewMs * 2);
    return { ok: true };
  }

  private prune(now: number): void {
    // Strict `<`, not `<=`: a nonce inserted at now1 = T - skewMs has
    // expiry = T + skewMs, which is exactly the far edge of the timestamp
    // window still valid for that same T (now2 = T + skewMs passes the skew
    // check too). Pruning on `<=` would delete the entry at exactly that
    // moment, letting the same request through a second time right at the
    // boundary. Keeping it one tick longer closes that gap.
    for (const [key, expiry] of this.seenNonces) {
      if (expiry < now) this.seenNonces.delete(key);
    }
  }
}

export function createReplayGuard(skewMs?: number): ReplayGuard {
  return new ReplayGuard(skewMs);
}
