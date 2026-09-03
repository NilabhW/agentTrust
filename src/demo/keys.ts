import fs from "node:fs";
import { JsonWebKey } from "node:crypto";

// Shared by src/demo/routes.ts and src/upsell/service.ts -- both sign a
// purchase server-side on a demo mandate's behalf for a UI/human-triggered
// action (as opposed to an autonomous external agent, which signs its own
// requests -- see src/agent/tools.ts). Demo-only; data/demo-keys.json is
// gitignored, created by `npm run seed`.

export interface DemoKeyEntry {
  agent_id: string;
  privateKeyJwk: JsonWebKey;
}

export type DemoKeys = Record<string, DemoKeyEntry>;

export function loadDemoKeys(demoKeysPath: string): DemoKeys | null {
  if (!fs.existsSync(demoKeysPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(demoKeysPath, "utf8")) as DemoKeys;
  } catch {
    return null;
  }
}
