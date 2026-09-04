import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GatewayService } from "../gateway/service";
import { WebhookService } from "../razorpay/webhook-service";
import { MandateStore } from "../mandate/store";
import { MandateNotFoundError, MandateIntegrityError } from "../mandate/errors";
import { ValidationError } from "../mandate/errors";
import { signAgentRequest, AgentSignedPayload, generateAgentKeypair } from "../gateway/agent-signature";
import { RazorpayWebhookPayload } from "../razorpay/types";
import { Category } from "../mandate/types";
import { validateCreateMandateInput } from "../mandate/validation";
import { loadDemoKeys, DemoKeys } from "./keys";

const DAY_MS = 24 * 60 * 60 * 1000;

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

  // Creates a mandate AND a fresh demo keypair together, so a mandate made
  // through the dashboard's "Create Mandate" panel is immediately usable by
  // the "Run Buyer Agent" panel -- unlike the real POST /mandates, which
  // expects the caller to already hold (and never disclose) a private key.
  fastify.post("/demo/mandates", async (request, reply) => {
    const body = request.body as {
      user_id?: string;
      agent_id?: string;
      category?: Category[];
      max_per_transaction?: number;
      max_cumulative?: number;
      rolling_window_seconds?: number;
      rolling_window_days?: number;
      expires_in_days?: number;
    };

    const { publicKey, privateKeyJwk } = generateAgentKeypair();
    const rollingWindowSeconds =
      body.rolling_window_seconds ??
      (body.rolling_window_days ? body.rolling_window_days * 24 * 60 * 60 : 30 * 24 * 60 * 60);
    const expiresAt = Date.now() + (body.expires_in_days ?? 30) * DAY_MS;

    let mandate;
    try {
      const validated = validateCreateMandateInput({
        user_id: body.user_id?.trim() || "demo-user",
        agent_id: body.agent_id,
        agent_public_key: publicKey,
        category: body.category,
        max_per_transaction: body.max_per_transaction,
        max_cumulative: body.max_cumulative,
        rolling_window_seconds: rollingWindowSeconds,
        expires_at: expiresAt,
      });
      mandate = mandateStore.create(validated);
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }

    const existing = loadDemoKeys(demoKeysPath) ?? {};
    const updated: DemoKeys = {
      ...existing,
      [mandate.mandate_id]: { agent_id: mandate.agent_id, privateKeyJwk },
    };
    fs.mkdirSync(path.dirname(demoKeysPath), { recursive: true });
    fs.writeFileSync(demoKeysPath, JSON.stringify(updated, null, 2));

    return reply.code(200).send(mandate);
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
