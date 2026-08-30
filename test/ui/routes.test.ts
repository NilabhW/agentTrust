import { describe, it, expect, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildTestDb, TEST_SIGNING_KEY } from "../setup";
import { buildApp } from "../../src/app";

describe("GET /", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ db: buildTestDb(), signingKey: TEST_SIGNING_KEY });
  });

  it("returns 200 with a text/html content-type and the page's root container element", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/id="audit-log"/);
  });
});
