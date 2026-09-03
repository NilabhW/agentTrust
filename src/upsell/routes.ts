import type { FastifyInstance } from "fastify";
import { UpsellService } from "./service";
import { UpsellNotFoundError } from "./errors";

export interface UpsellRoutesOptions {
  upsellService: UpsellService;
}

export async function upsellRoutes(fastify: FastifyInstance, opts: UpsellRoutesOptions) {
  const { upsellService } = opts;

  fastify.get("/upsell/pending", async (_request, reply) => {
    return reply.code(200).send(upsellService.listPending());
  });

  fastify.get("/upsell/metrics", async (_request, reply) => {
    return reply.code(200).send(upsellService.metrics());
  });

  fastify.post<{ Params: { id: string } }>("/upsell/:id/accept", async (request, reply) => {
    try {
      const { httpStatus, result } = await upsellService.accept(request.params.id);
      return reply.code(httpStatus).send(result);
    } catch (err) {
      if (err instanceof UpsellNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.post<{ Params: { id: string } }>("/upsell/:id/decline", async (request, reply) => {
    try {
      const { httpStatus, result } = upsellService.decline(request.params.id);
      return reply.code(httpStatus).send(result);
    } catch (err) {
      if (err instanceof UpsellNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });
}
