import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";

const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.join(process.cwd(), "public");
const INDEX_HTML_PATH = path.join(PUBLIC_DIR, "index.html");

export async function uiRoutes(fastify: FastifyInstance) {
  fastify.get("/", async (_request, reply) => {
    const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
