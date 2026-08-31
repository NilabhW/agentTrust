function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive finite number, got: ${raw}`);
  }
  return value;
}

export const config = {
  mandateSigningKey: requireEnv("MANDATE_SIGNING_KEY"),
  dbPath: process.env.DB_PATH ?? "./data/mandates.db",
  port: positiveIntEnv("PORT", 3000),
  replaySkewMs: positiveIntEnv("REPLAY_SKEW_MS", 120_000),
  stepUpTimeoutMs: positiveIntEnv("STEP_UP_TIMEOUT_MS", 300_000),
  // Optional -- Program 3 (Razorpay). Left unset, the Gateway behaves
  // exactly as it did before Program 3 existed (order_id stays null, no
  // order_created entries, no webhook route registered).
  razorpayKeyId: process.env.RAZORPAY_KEY_ID,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
};
