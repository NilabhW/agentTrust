import fs from "node:fs";
import path from "node:path";
import { randomUUID, JsonWebKey } from "node:crypto";
import { signAgentRequest, AgentSignedPayload } from "../src/gateway/agent-signature";

const [, , mandateIdArg, amountArg, categoryArg, itemDescriptionArg] = process.argv;

const demoKeysPath = path.join(process.cwd(), "data", "demo-keys.json");
if (!fs.existsSync(demoKeysPath)) {
  console.error(`No demo keys found at ${demoKeysPath}. Run \`npm run seed\` first.`);
  process.exit(1);
}

const demoKeys = JSON.parse(fs.readFileSync(demoKeysPath, "utf8")) as Record<
  string,
  { agent_id: string; privateKeyJwk: JsonWebKey }
>;

const mandateId = mandateIdArg ?? Object.keys(demoKeys)[0];
if (!mandateId || !demoKeys[mandateId]) {
  console.error(
    `Usage: npm run sign-demo-request -- <mandate_id> [amount] [category] [item_description]\n` +
      `Available mandate_ids: ${Object.keys(demoKeys).join(", ")}`
  );
  process.exit(1);
}

const payload: AgentSignedPayload = {
  mandate_id: mandateId,
  amount: amountArg ? Number(amountArg) : 100,
  category: categoryArg ?? "groceries",
  item_description: itemDescriptionArg ?? "demo purchase",
  timestamp: Date.now(),
  nonce: randomUUID(),
};

const agent_signature = signAgentRequest(payload, demoKeys[mandateId].privateKeyJwk);
const body = { ...payload, agent_signature };

console.log("Signed request body:");
console.log(JSON.stringify(body, null, 2));
console.log("\nReady-to-paste curl command:\n");
console.log(
  `curl -X POST http://localhost:3000/gateway/verify -H "Content-Type: application/json" -d '${JSON.stringify(body)}'`
);
