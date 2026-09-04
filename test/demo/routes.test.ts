import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { createMandateStore } from "../../src/mandate/store";

describe("POST /demo/mandates", () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let demoKeysPath: string;

  beforeEach(() => {
    db = buildTestDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-routes-test-"));
    demoKeysPath = path.join(dir, "demo-keys.json");
    app = buildApp({ db, signingKey: TEST_SIGNING_KEY, demoKeysPath });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(demoKeysPath), { recursive: true, force: true });
  });

  it("creates a mandate with a freshly generated keypair and writes the private key to demo-keys.json", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/demo/mandates",
      payload: {
        agent_id: "video-demo-agent",
        category: ["groceries"],
        max_per_transaction: 1000,
        max_cumulative: 4000,
        expires_in_days: 30,
      },
    });

    expect(res.statusCode).toBe(200);
    const mandate = res.json();
    expect(mandate.agent_id).toBe("video-demo-agent");
    expect(mandate.status).toBe("active");
    expect(mandate.max_per_transaction).toBe(1000);

    const savedKeys = JSON.parse(fs.readFileSync(demoKeysPath, "utf8"));
    expect(savedKeys[mandate.mandate_id]).toBeDefined();
    expect(savedKeys[mandate.mandate_id].agent_id).toBe("video-demo-agent");
    expect(savedKeys[mandate.mandate_id].privateKeyJwk).toBeDefined();

    // The mandate the store actually persisted must verify against the same
    // signature scheme as any other mandate -- this route can't be allowed
    // to create a mandate that bypasses that.
    const stored = createMandateStore(db, TEST_SIGNING_KEY).getById(mandate.mandate_id, Date.now());
    expect(stored.agent_public_key).toBe(mandate.agent_public_key);
  });

  it("preserves existing demo keys already on disk instead of overwriting them", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/demo/mandates",
      payload: { agent_id: "agent-a", category: ["groceries"], max_per_transaction: 500, max_cumulative: 2000 },
    });
    const second = await app.inject({
      method: "POST",
      url: "/demo/mandates",
      payload: { agent_id: "agent-b", category: ["electronics"], max_per_transaction: 500, max_cumulative: 2000 },
    });

    const savedKeys = JSON.parse(fs.readFileSync(demoKeysPath, "utf8"));
    expect(Object.keys(savedKeys)).toHaveLength(2);
    expect(savedKeys[first.json().mandate_id]).toBeDefined();
    expect(savedKeys[second.json().mandate_id]).toBeDefined();
  });

  it("rejects an invalid category the same way POST /mandates would", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/demo/mandates",
      payload: { agent_id: "agent-c", category: ["not-a-real-category"], max_per_transaction: 500, max_cumulative: 2000 },
    });

    expect(res.statusCode).toBe(400);
  });

  it("defaults rolling_window and expiry to sensible values when not provided", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/demo/mandates",
      payload: { agent_id: "agent-d", category: ["groceries"], max_per_transaction: 500, max_cumulative: 2000 },
    });

    expect(res.statusCode).toBe(200);
    const mandate = res.json();
    expect(mandate.rolling_window_seconds).toBeGreaterThan(0);
    expect(mandate.expires_at).toBeGreaterThan(Date.now());
  });
});
