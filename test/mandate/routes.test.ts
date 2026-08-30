import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-1",
    agent_id: "agent-1",
    agent_public_key: "pubkey-abc",
    category: ["groceries"],
    max_per_transaction: 500,
    max_cumulative: 2000,
    rolling_window_seconds: 86400,
    expires_at: Date.now() + 1000 * 60 * 60 * 24,
    ...overrides,
  };
}

describe("mandate routes", () => {
  let app: FastifyInstance;
  let db: Database.Database;

  beforeEach(() => {
    db = buildTestDb();
    app = buildApp({ db, signingKey: TEST_SIGNING_KEY });
  });

  describe("POST /mandates", () => {
    it("returns 201 with mandate_id, signature, and status=active on valid input", async () => {
      const res = await app.inject({ method: "POST", url: "/mandates", payload: validBody() });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.mandate_id).toBeTruthy();
      expect(body.signature).toBeTruthy();
      expect(body.status).toBe("active");
    });

    it("returns 400 with a clear field-specific message for missing expires_at", async () => {
      const { expires_at, ...rest } = validBody();
      const res = await app.inject({ method: "POST", url: "/mandates", payload: rest });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/expires_at/);
    });

    it("returns 400 for missing agent_public_key", async () => {
      const { agent_public_key, ...rest } = validBody();
      const res = await app.inject({ method: "POST", url: "/mandates", payload: rest });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/agent_public_key/);
    });

    it("returns 400 for an out-of-enum category", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ category: ["gambling"] }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/category/);
    });
  });

  describe("POST /mandates/:id/revoke", () => {
    it("returns 200 with status=revoked", async () => {
      const created = await app.inject({ method: "POST", url: "/mandates", payload: validBody() });
      const id = created.json().mandate_id;
      const res = await app.inject({ method: "POST", url: `/mandates/${id}/revoke` });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("revoked");
    });

    it("returns 404 on an unknown id", async () => {
      const res = await app.inject({ method: "POST", url: "/mandates/does-not-exist/revoke" });
      expect(res.statusCode).toBe(404);
    });

    it("returns 500 with error=MANDATE_SIGNATURE_INVALID when revoking an already-tampered mandate", async () => {
      const created = await app.inject({ method: "POST", url: "/mandates", payload: validBody() });
      const id = created.json().mandate_id;
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(999999, id);
      const res = await app.inject({ method: "POST", url: `/mandates/${id}/revoke` });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("MANDATE_SIGNATURE_INVALID");
    });
  });

  describe("GET /mandates/:id", () => {
    it("returns the mandate with status=active and a current_cumulative_spend field", async () => {
      const created = await app.inject({ method: "POST", url: "/mandates", payload: validBody() });
      const id = created.json().mandate_id;
      const res = await app.inject({ method: "GET", url: `/mandates/${id}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("active");
      expect(body.current_cumulative_spend).toBe(0);
    });

    it("returns status=expired after expires_at has passed", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ expires_at: Date.now() + 10 }),
      });
      const id = created.json().mandate_id;
      await new Promise((resolve) => setTimeout(resolve, 20));
      const res = await app.inject({ method: "GET", url: `/mandates/${id}` });
      expect(res.json().status).toBe("expired");
    });

    it("returns status=revoked after revoke", async () => {
      const created = await app.inject({ method: "POST", url: "/mandates", payload: validBody() });
      const id = created.json().mandate_id;
      await app.inject({ method: "POST", url: `/mandates/${id}/revoke` });
      const res = await app.inject({ method: "GET", url: `/mandates/${id}` });
      expect(res.json().status).toBe("revoked");
    });

    it("returns 500 with error=MANDATE_SIGNATURE_INVALID after a field is tampered with directly in the DB", async () => {
      const created = await app.inject({ method: "POST", url: "/mandates", payload: validBody() });
      const id = created.json().mandate_id;
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(999999, id);
      const res = await app.inject({ method: "GET", url: `/mandates/${id}` });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("MANDATE_SIGNATURE_INVALID");
    });

    it("returns 404 on an unknown id", async () => {
      const res = await app.inject({ method: "GET", url: "/mandates/does-not-exist" });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /mandates?user_id=", () => {
    it("returns all mandates for that user, each with correctly computed status", async () => {
      await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ user_id: "user-list-1" }),
      });
      await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ user_id: "user-list-1" }),
      });
      const res = await app.inject({ method: "GET", url: "/mandates?user_id=user-list-1" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });

    it("returns an empty array, not a 404, when no mandates match", async () => {
      const res = await app.inject({ method: "GET", url: "/mandates?user_id=nobody" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns 500 with error=MANDATE_SIGNATURE_INVALID when a listed mandate has been tampered with", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ user_id: "user-tampered-list" }),
      });
      const id = created.json().mandate_id;
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(999999, id);
      const res = await app.inject({ method: "GET", url: "/mandates?user_id=user-tampered-list" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("MANDATE_SIGNATURE_INVALID");
    });
  });

  describe("GET /mandates (no user_id)", () => {
    it("returns every mandate across all users when the user_id query parameter is omitted", async () => {
      await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ user_id: "user-all-1" }),
      });
      await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ user_id: "user-all-2" }),
      });
      const res = await app.inject({ method: "GET", url: "/mandates" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });

    it("returns an empty array, not an error, when there are no mandates at all", async () => {
      const res = await app.inject({ method: "GET", url: "/mandates" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns 500 with error=MANDATE_SIGNATURE_INVALID when any mandate has been tampered with", async () => {
      const created = await app.inject({
        method: "POST",
        url: "/mandates",
        payload: validBody({ user_id: "user-all-tampered" }),
      });
      const id = created.json().mandate_id;
      db.prepare("UPDATE mandates SET max_cumulative = ? WHERE mandate_id = ?").run(999999, id);
      const res = await app.inject({ method: "GET", url: "/mandates" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe("MANDATE_SIGNATURE_INVALID");
    });
  });
});
