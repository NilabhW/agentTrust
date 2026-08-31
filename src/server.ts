import { config } from "./config";
import { createDb } from "./db/client";
import { buildApp } from "./app";

const db = createDb(config.dbPath);
const app = buildApp({
  db,
  signingKey: config.mandateSigningKey,
  replaySkewMs: config.replaySkewMs,
  stepUpTimeoutMs: config.stepUpTimeoutMs,
  razorpayKeyId: config.razorpayKeyId,
  razorpayKeySecret: config.razorpayKeySecret,
  razorpayWebhookSecret: config.razorpayWebhookSecret,
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    console.log(`Mandate Service listening on port ${config.port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
