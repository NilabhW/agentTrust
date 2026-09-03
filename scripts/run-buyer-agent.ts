import fs from "node:fs";
import path from "node:path";
import { JsonWebKey } from "node:crypto";
import { GeminiClient } from "../src/agent/gemini-client";
import { runBuyerAgent } from "../src/agent/loop";
import { TranscriptTurn } from "../src/agent/types";

const CANNED_GOALS: Record<string, string> = {
  clean: "Order some groceries for tonight's dinner. Keep it modest -- nothing extravagant.",
  "step-up":
    "Stock up on groceries for the next couple of weeks. Buy several different staple items, one purchase " +
    "at a time, until you can't reasonably buy any more.",
  "hard-fail": "Buy a premium espresso coffee machine for the office.",
};

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = value;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error(
      "GEMINI_API_KEY is not set. Add it to .env (never paste it into chat) -- see .env.example."
    );
    process.exit(1);
  }
  const model = process.env.GEMINI_MODEL; // GeminiClient falls back to its own default if unset
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";

  const demoKeysPath = path.join(process.cwd(), "data", "demo-keys.json");
  if (!fs.existsSync(demoKeysPath)) {
    console.error(`No demo keys found at ${demoKeysPath}. Run \`npm run seed\` first.`);
    process.exit(1);
  }
  const demoKeys = JSON.parse(fs.readFileSync(demoKeysPath, "utf8")) as Record<
    string,
    { agent_id: string; privateKeyJwk: JsonWebKey }
  >;

  const mandateId = args.mandate ?? Object.keys(demoKeys)[0];
  const keyEntry = mandateId ? demoKeys[mandateId] : undefined;
  if (!keyEntry) {
    console.error(
      `Unknown mandate_id "${mandateId}".\nAvailable: ${Object.keys(demoKeys).join(", ")}`
    );
    process.exit(1);
  }

  const goal = args.goal ?? (args.canned ? CANNED_GOALS[args.canned] : undefined);
  if (!goal) {
    console.error(
      `Usage: npm run buyer-agent -- --canned <${Object.keys(CANNED_GOALS).join("|")}> [--mandate <mandate_id>]\n` +
        `   or: npm run buyer-agent -- --goal "<free text goal>" [--mandate <mandate_id>]\n` +
        `Requires the Gateway to already be running (\`npm run dev\`).`
    );
    process.exit(1);
  }

  console.log(`Fetching mandate ${mandateId} from ${gatewayUrl} ...`);
  const mandateRes = await fetch(`${gatewayUrl}/mandates/${mandateId}`);
  if (!mandateRes.ok) {
    console.error(
      `Could not fetch mandate ${mandateId} from ${gatewayUrl} (status ${mandateRes.status}). ` +
        `Is \`npm run dev\` running?`
    );
    process.exit(1);
  }
  const mandate = (await mandateRes.json()) as { agent_id: string; category: string[] };

  console.log(`\nAgent: ${mandate.agent_id}`);
  console.log(`Allowed categories: ${mandate.category.join(", ")}`);
  console.log(`Goal: ${goal}\n`);
  console.log("--- transcript ---\n");

  const onTurn = (turn: TranscriptTurn) => {
    console.log(`[turn ${turn.turn}]`);
    if (turn.modelText) console.log(`  model: ${turn.modelText}`);
    for (const call of turn.toolCalls) {
      console.log(`  tool call: ${call.name}(${JSON.stringify(call.args)})`);
      console.log(`  tool result: ${JSON.stringify(call.result)}`);
    }
    console.log("");
  };

  const geminiClient = new GeminiClient({ apiKey, model });

  const transcript = await runBuyerAgent({
    goal,
    mandateId,
    agentId: mandate.agent_id,
    allowedCategories: mandate.category,
    geminiClient,
    toolContext: { gatewayUrl, privateKeyJwk: keyEntry.privateKeyJwk },
    onTurn,
  });

  console.log("--- summary ---");
  console.log(`Stopped because: ${transcript.stopReason}`);
  console.log(`Final message: ${transcript.finalMessage ?? "(none)"}`);
  console.log(`\nSee the full record in the dashboard's audit log: ${gatewayUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
