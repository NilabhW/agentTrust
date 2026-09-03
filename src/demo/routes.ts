import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { GatewayService } from "../gateway/service";
import { WebhookService } from "../razorpay/webhook-service";
import { MandateStore } from "../mandate/store";
import { MandateNotFoundError, MandateIntegrityError } from "../mandate/errors";
import { signAgentRequest, AgentSignedPayload } from "../gateway/agent-signature";
import { RazorpayWebhookPayload } from "../razorpay/types";
import { Category } from "../mandate/types";
import { loadDemoKeys } from "./keys";

// Demo-only convenience routes for driving the whole pipeline from the UI
// during a live demo, without a terminal. These deliberately bypass the
// real trust boundaries (they sign requests on the agent's behalf using
// keys read straight off disk, and settle payments without any webhook
// signature) -- they only exist so `data/demo-keys.json` (gitignored,
// created by `npm run seed`) can drive a click-through demo. Never treat
// this module as a template for a real integration.

export interface DemoRoutesOptions {
  gatewayService: GatewayService;
  webhookService: WebhookService;
  mandateStore: MandateStore;
  demoKeysPath: string;
}

export async function demoRoutes(fastify: FastifyInstance, opts: DemoRoutesOptions) {
  const { gatewayService, webhookService, mandateStore, demoKeysPath } = opts;

  fastify.get("/demo/agents", async (_request, reply) => {
    const demoKeys = loadDemoKeys(demoKeysPath);
    if (!demoKeys) return reply.code(200).send([]);

    const now = Date.now();
    const agents = Object.keys(demoKeys).flatMap((mandateId) => {
      try {
        const mandate = mandateStore.getById(mandateId, now);
        return [
          {
            mandate_id: mandate.mandate_id,
            agent_id: mandate.agent_id,
            category: mandate.category,
            max_per_transaction: mandate.max_per_transaction,
            max_cumulative: mandate.max_cumulative,
            current_cumulative_spend: mandate.current_cumulative_spend,
            status: mandate.status,
          },
        ];
      } catch (err) {
        if (err instanceof MandateNotFoundError || err instanceof MandateIntegrityError) return [];
        throw err;
      }
    });
    return reply.code(200).send(agents);
  });

  fastify.post("/demo/purchase", async (request, reply) => {
    const demoKeys = loadDemoKeys(demoKeysPath);
    if (!demoKeys) {
      return reply.code(400).send({ error: "No demo keys found. Run `npm run seed` first." });
    }

    const body = request.body as {
      mandate_id?: string;
      amount?: number;
      category?: Category;
      item_description?: string;
    };
    const entry = body.mandate_id ? demoKeys[body.mandate_id] : undefined;
    if (!entry) {
      return reply.code(400).send({ error: "Unknown demo mandate_id. Run `npm run seed` first." });
    }

    const payload: AgentSignedPayload = {
      mandate_id: body.mandate_id!,
      amount: Number(body.amount),
      category: body.category ?? "groceries",
      item_description: body.item_description?.trim() || "demo purchase",
      timestamp: Date.now(),
      nonce: randomUUID(),
    };
    const agent_signature = signAgentRequest(payload, entry.privateKeyJwk);

    // Mirrors the production route's own rule: the agent side of this
    // exchange must never learn its own pending_approval_id.
    const { pending_approval_id: _internalOnly, ...result } = await gatewayService.verify({
      ...payload,
      agent_signature,
    });
    return reply.code(200).send(result);
  });

  fastify.post("/demo/settle", async (request, reply) => {
    const body = request.body as { order_id?: string; outcome?: "paid" | "failed" };
    if (!body.order_id) {
      return reply.code(400).send({ error: "order_id is required" });
    }

    const outcome = body.outcome === "failed" ? "failed" : "paid";
    const paymentId = `pay_demo_${randomUUID().slice(0, 12)}`;

    const webhookBody: RazorpayWebhookPayload =
      outcome === "paid"
        ? {
            event: "order.paid",
            payload: {
              order: { entity: { id: body.order_id, amount: 0, status: "paid" } },
              payment: {
                entity: {
                  id: paymentId,
                  order_id: body.order_id,
                  amount: 0,
                  status: "captured",
                  error_code: null,
                  error_description: null,
                },
              },
            },
          }
        : {
            event: "payment.failed",
            payload: {
              payment: {
                entity: {
                  id: paymentId,
                  order_id: body.order_id,
                  amount: 0,
                  status: "failed",
                  error_code: "BAD_REQUEST_ERROR",
                  error_description: "Simulated test-mode decline",
                },
              },
            },
          };

    webhookService.handleEvent(webhookBody);
    return reply.code(200).send({ ok: true });
  });
}
