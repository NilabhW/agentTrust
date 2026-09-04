import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import path from "node:path";
import { createMandateStore } from "./mandate/store";
import { MandateService } from "./mandate/service";
import { mandateRoutes } from "./mandate/routes";
import { createAuditStore } from "./audit/store";
import { AuditService } from "./audit/service";
import { auditRoutes } from "./audit/routes";
import { uiRoutes } from "./ui/routes";
import { createPendingApprovalStore } from "./gateway/store";
import { createReplayGuard } from "./gateway/replay";
import { GatewayService } from "./gateway/service";
import { gatewayRoutes } from "./gateway/routes";
import { RazorpayClient } from "./razorpay/client";
import { createOrdersStore } from "./razorpay/orders-store";
import { WebhookService } from "./razorpay/webhook-service";
import { razorpayRoutes } from "./razorpay/routes";
import { demoRoutes } from "./demo/routes";
import { GroqClient } from "./upsell/groq-client";
import { createUpsellStore } from "./upsell/store";
import { UpsellService } from "./upsell/service";
import { upsellRoutes } from "./upsell/routes";
import { agentRoutes } from "./agent/routes";

export interface BuildAppOptions {
  db: Database.Database;
  signingKey: string;
  replaySkewMs?: number;
  stepUpTimeoutMs?: number;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
  groqApiKey?: string;
  groqModel?: string;
  groqAgentModel?: string;
  // Override for tests; defaults to <cwd>/data/demo-keys.json (created by
  // `npm run seed`) otherwise.
  demoKeysPath?: string;
  // Override for tests, so a fake Groq response can be injected without
  // touching the real network. Only threaded into the agent-run route's
  // GroqAgentClient -- never into the Gateway calls themselves, which must
  // stay real HTTP even in this self-referential path (see agent/routes.ts).
  fetchImpl?: typeof fetch;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const fastify = Fastify({ logger: false });

  const mandateStore = createMandateStore(opts.db, opts.signingKey);
  const mandateService = new MandateService(mandateStore);
  fastify.register(mandateRoutes, { service: mandateService });

  const auditStore = createAuditStore(opts.db);
  const auditService = new AuditService(auditStore);
  fastify.register(auditRoutes, { service: auditService });

  const ordersStore = createOrdersStore(opts.db);
  const razorpayClient =
    opts.razorpayKeyId && opts.razorpayKeySecret
      ? new RazorpayClient({ keyId: opts.razorpayKeyId, keySecret: opts.razorpayKeySecret })
      : undefined;

  const pendingApprovalStore = createPendingApprovalStore(opts.db, opts.stepUpTimeoutMs);
  const replayGuard = createReplayGuard(opts.replaySkewMs);
  const gatewayService = new GatewayService(
    mandateStore,
    auditStore,
    pendingApprovalStore,
    replayGuard,
    razorpayClient,
    ordersStore
  );
  fastify.register(gatewayRoutes, { service: gatewayService });

  const webhookService = new WebhookService(ordersStore, auditStore);

  if (opts.razorpayWebhookSecret) {
    fastify.register(razorpayRoutes, {
      webhookService,
      webhookSecret: opts.razorpayWebhookSecret,
    });
  }

  const demoKeysPath = opts.demoKeysPath ?? path.join(process.cwd(), "data", "demo-keys.json");

  if (opts.groqApiKey) {
    const groqClient = new GroqClient({ apiKey: opts.groqApiKey, model: opts.groqModel });
    const upsellStore = createUpsellStore(opts.db);
    const upsellService = new UpsellService(upsellStore, auditStore, groqClient, gatewayService, demoKeysPath);
    gatewayService.setUpsellService(upsellService);
    fastify.register(upsellRoutes, { upsellService });

    fastify.register(agentRoutes, {
      mandateStore,
      demoKeysPath,
      groqApiKey: opts.groqApiKey,
      groqAgentModel: opts.groqAgentModel,
      fetchImpl: opts.fetchImpl,
    });
  }

  fastify.register(demoRoutes, {
    gatewayService,
    webhookService,
    mandateStore,
    demoKeysPath,
  });

  fastify.register(uiRoutes);

  return fastify;
}
