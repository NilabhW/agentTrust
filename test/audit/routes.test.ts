import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";
import { createAuditStore } from "../../src/audit/store";

describe("GET /audit", () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb();
    app = buildApp({ db, signingKey: TEST_SIGNING_KEY });
  });

  function seed(count: number) {
    const store = createAuditStore(db);
    const entries = [];
    for (let i = 0; i < count; i++) {
      entries.push(
        store.writeEntry({
          mandate_id: `mandate-${i % 2}`,
          agent_id: "agent-1",
          request_amount: 100,
          category: "groceries",
          decision: i % 2 === 0 ? "pass" : "hard_fail",
          reason: "demo entry",
        })
      );
    }
    return entries;
  }

  it("returns 200 with entries newest-first for a populated log", async () => {
    const entries = seed(3);
    const res = await app.inject({ method: "GET", url: "/audit" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.map((e: { id: number }) => e.id)).toEqual(
      [...entries].reverse().map((e) => e.id)
    );
  });

  it("returns 200 with an empty entries array and next_before_id=null when the log is empty", async () => {
    const res = await app.inject({ method: "GET", url: "/audit" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ entries: [], next_before_id: null });
  });

  it("applies the default limit of 50 when no limit query param is given", async () => {
    seed(60);
    const res = await app.inject({ method: "GET", url: "/audit" });
    expect(res.json().entries).toHaveLength(50);
  });

  it("respects a custom ?limit= query param", async () => {
    seed(10);
    const res = await app.inject({ method: "GET", url: "/audit?limit=3" });
    expect(res.json().entries).toHaveLength(3);
  });

  it("paginates correctly using the ?before_id= cursor returned from the previous page", async () => {
    seed(5);
    const firstPage = await app.inject({ method: "GET", url: "/audit?limit=2" });
    const firstBody = firstPage.json();
    expect(firstBody.entries).toHaveLength(2);
    expect(firstBody.next_before_id).not.toBeNull();

    const secondPage = await app.inject({
      method: "GET",
      url: `/audit?limit=2&before_id=${firstBody.next_before_id}`,
    });
    const secondBody = secondPage.json();
    expect(secondBody.entries).toHaveLength(2);

    const firstIds = firstBody.entries.map((e: { id: number }) => e.id);
    const secondIds = secondBody.entries.map((e: { id: number }) => e.id);
    expect(firstIds.some((id: number) => secondIds.includes(id))).toBe(false);
  });

  it("returns 400 with a clear message for a non-numeric limit", async () => {
    const res = await app.inject({ method: "GET", url: "/audit?limit=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/limit/);
  });

  it("returns 400 with a clear message for a non-numeric before_id", async () => {
    const res = await app.inject({ method: "GET", url: "/audit?before_id=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/before_id/);
  });

  it("returns 400 for an invalid ?decision= filter value", async () => {
    const res = await app.inject({ method: "GET", url: "/audit?decision=bogus" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/decision/);
  });

  it("filters by ?mandate_id= when provided", async () => {
    seed(4);
    const res = await app.inject({ method: "GET", url: "/audit?mandate_id=mandate-0" });
    const body = res.json();
    expect(body.entries.length).toBeGreaterThan(0);
    for (const entry of body.entries) {
      expect(entry.mandate_id).toBe("mandate-0");
    }
  });

  it("filters by ?decision= when provided", async () => {
    seed(4);
    const res = await app.inject({ method: "GET", url: "/audit?decision=hard_fail" });
    const body = res.json();
    expect(body.entries.length).toBeGreaterThan(0);
    for (const entry of body.entries) {
      expect(entry.decision).toBe("hard_fail");
    }
  });
});
