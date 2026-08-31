import type { FastifyInstance } from "fastify";
import { verifyWebhookSignature } from "./webhook-signature";
import { WebhookService } from "./webhook-service";
import { RazorpayWebhookPayload } from "./types";

export interface RazorpayRoutesOptions {
  webhookService: WebhookService;
  webhookSecret: string;
}

export async function razorpayRoutes(fastify: FastifyInstance, opts: RazorpayRoutesOptions) {
  const { webhookService, webhookSecret } = opts;

  // Scoped to this plugin only (Fastify encapsulates content-type parsers
  // per-plugin) -- signature verification per Razorpay's docs must run
  // against the exact raw bytes, before any JSON parsing/reserialization.
  fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });

  fastify.post("/razorpay/webhook", async (request, reply) => {
    const rawBody = request.body as Buffer;
    const signature = request.headers["x-razorpay-signature"];

    if (typeof signature !== "string" || !verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      return reply.code(400).send({ error: "invalid webhook signature" });
    }

    let parsed: RazorpayWebhookPayload;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return reply.code(400).send({ error: "malformed JSON body" });
    }

    webhookService.handleEvent(parsed);
    return reply.code(200).send({ received: true });
  });
}
