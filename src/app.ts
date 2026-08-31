import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
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

export interface BuildAppOptions {
  db: Database.Database;
  signingKey: string;
  replaySkewMs?: number;
  stepUpTimeoutMs?: number;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
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

  if (opts.razorpayWebhookSecret) {
    const webhookService = new WebhookService(ordersStore, auditStore);
    fastify.register(razorpayRoutes, {
      webhookService,
      webhookSecret: opts.razorpayWebhookSecret,
    });
  }

  fastify.register(uiRoutes);

  return fastify;
}
