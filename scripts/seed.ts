import fs from "node:fs";
import path from "node:path";
import { JsonWebKey } from "node:crypto";
import { config } from "../src/config";
import { createDb } from "../src/db/client";
import { createMandateStore } from "../src/mandate/store";
import { generateAgentKeypair } from "../src/gateway/agent-signature";

const db = createDb(config.dbPath);
const store = createMandateStore(db, config.mandateSigningKey);

const DAY_MS = 24 * 60 * 60 * 1000;

const seeds = [
  {
    user_id: "demo-user-1",
    agent_id: "demo-agent-1",
    category: ["groceries", "food_delivery"] as const,
    max_per_transaction: 1500,
    max_cumulative: 10000,
    rolling_window_seconds: 7 * 24 * 60 * 60,
    expires_at: Date.now() + 30 * DAY_MS,
  },
  {
    user_id: "demo-user-1",
    agent_id: "demo-agent-2",
    category: ["subscriptions"] as const,
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 30 * 24 * 60 * 60,
    expires_at: Date.now() + 90 * DAY_MS,
  },
  {
    user_id: "demo-user-2",
    agent_id: "demo-agent-3",
    category: ["electronics"] as const,
    max_per_transaction: 20000,
    max_cumulative: 50000,
    rolling_window_seconds: 24 * 60 * 60,
    expires_at: Date.now() + 7 * DAY_MS,
  },
];

const demoKeys: Record<string, { agent_id: string; privateKeyJwk: JsonWebKey }> = {};

for (const seed of seeds) {
  const { publicKey, privateKeyJwk } = generateAgentKeypair();
  const mandate = store.create({
    ...seed,
    category: [...seed.category],
    agent_public_key: publicKey,
  });
  demoKeys[mandate.mandate_id] = { agent_id: mandate.agent_id, privateKeyJwk };
  console.log(`Seeded mandate ${mandate.mandate_id} for ${mandate.user_id} (${mandate.agent_id})`);
}

const demoKeysPath = path.join(process.cwd(), "data", "demo-keys.json");
fs.mkdirSync(path.dirname(demoKeysPath), { recursive: true });
fs.writeFileSync(demoKeysPath, JSON.stringify(demoKeys, null, 2));
console.log(`Wrote agent private keys for demo signing to ${demoKeysPath}`);
