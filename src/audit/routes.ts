import type { FastifyInstance } from "fastify";
import { AuditService } from "./service";
import { parseListAuditQuery } from "./validation";
import { AuditValidationError } from "./errors";

export interface AuditRoutesOptions {
  service: AuditService;
}

export async function auditRoutes(fastify: FastifyInstance, opts: AuditRoutesOptions) {
  const { service } = opts;

  fastify.get<{ Querystring: Record<string, unknown> }>("/audit", async (request, reply) => {
    try {
      const options = parseListAuditQuery(request.query);
      const result = service.list(options);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof AuditValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
