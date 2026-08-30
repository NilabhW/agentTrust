import type { FastifyInstance } from "fastify";
import { GatewayService } from "./service";
import { GatewayValidationError, PendingApprovalNotFoundError } from "./errors";
import { MandateIntegrityError } from "../mandate/errors";

export interface GatewayRoutesOptions {
  service: GatewayService;
}

export async function gatewayRoutes(fastify: FastifyInstance, opts: GatewayRoutesOptions) {
  const { service } = opts;

  fastify.post("/gateway/verify", async (request, reply) => {
    try {
      const { pending_approval_id: _internalOnly, ...result } = service.verify(request.body);
      // pending_approval_id is deliberately withheld from the agent-facing
      // response: the approve/deny endpoints have no separate operator
      // credential, so handing the agent its own approval id would let it
      // self-approve a step-up it was itself flagged for. A human resolves
      // step-ups by discovering them via GET /gateway/pending-approvals.
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof GatewayValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof MandateIntegrityError) {
        return reply.code(500).send({ error: "MANDATE_SIGNATURE_INVALID" });
      }
      throw err;
    }
  });

  fastify.post<{ Params: { id: string } }>(
    "/gateway/pending-approvals/:id/approve",
    async (request, reply) => {
      try {
        const { httpStatus, approval } = service.approveStepUp(request.params.id);
        return reply.code(httpStatus).send(approval);
      } catch (err) {
        if (err instanceof PendingApprovalNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof MandateIntegrityError) {
          return reply.code(500).send({ error: "MANDATE_SIGNATURE_INVALID" });
        }
        throw err;
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    "/gateway/pending-approvals/:id/deny",
    async (request, reply) => {
      try {
        const { httpStatus, approval } = service.denyStepUp(request.params.id);
        return reply.code(httpStatus).send(approval);
      } catch (err) {
        if (err instanceof PendingApprovalNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof MandateIntegrityError) {
          return reply.code(500).send({ error: "MANDATE_SIGNATURE_INVALID" });
        }
        throw err;
      }
    }
  );

  const listPendingApprovals = async () => service.listPendingApprovals();

  fastify.get("/gateway/pending-approvals", async (_request, reply) => {
    return reply.code(200).send(await listPendingApprovals());
  });

  fastify.get("/mandates/pending-approvals", async (_request, reply) => {
    return reply.code(200).send(await listPendingApprovals());
  });
}
