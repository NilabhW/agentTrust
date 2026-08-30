import type { FastifyInstance } from "fastify";
import { MandateService } from "./service";
import { ValidationError, MandateNotFoundError, MandateIntegrityError } from "./errors";

export interface MandateRoutesOptions {
  service: MandateService;
}

export async function mandateRoutes(fastify: FastifyInstance, opts: MandateRoutesOptions) {
  const { service } = opts;

  fastify.post("/mandates", async (request, reply) => {
    try {
      const mandate = service.create(request.body);
      return reply.code(201).send(mandate);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.post<{ Params: { id: string } }>("/mandates/:id/revoke", async (request, reply) => {
    try {
      service.revoke(request.params.id);
      const mandate = service.getById(request.params.id);
      return reply.code(200).send(mandate);
    } catch (err) {
      if (err instanceof MandateNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof MandateIntegrityError) {
        return reply.code(500).send({ error: "MANDATE_SIGNATURE_INVALID" });
      }
      throw err;
    }
  });

  fastify.get<{ Params: { id: string } }>("/mandates/:id", async (request, reply) => {
    try {
      const mandate = service.getById(request.params.id);
      return reply.code(200).send(mandate);
    } catch (err) {
      if (err instanceof MandateNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof MandateIntegrityError) {
        return reply.code(500).send({ error: "MANDATE_SIGNATURE_INVALID" });
      }
      throw err;
    }
  });

  fastify.get<{ Querystring: { user_id?: string } }>("/mandates", async (request, reply) => {
    const userId = request.query.user_id;
    if (!userId) {
      return reply.code(400).send({ error: "user_id query parameter is required" });
    }
    try {
      const mandates = service.listByUser(userId);
      return reply.code(200).send(mandates);
    } catch (err) {
      if (err instanceof MandateIntegrityError) {
        return reply.code(500).send({ error: "MANDATE_SIGNATURE_INVALID" });
      }
      throw err;
    }
  });
}
