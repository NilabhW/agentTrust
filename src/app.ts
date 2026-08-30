import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createMandateStore } from "./mandate/store";
import { MandateService } from "./mandate/service";
import { mandateRoutes } from "./mandate/routes";
import { createAuditStore } from "./audit/store";
import { AuditService } from "./audit/service";
import { auditRoutes } from "./audit/routes";
import { uiRoutes } from "./ui/routes";

export interface BuildAppOptions {
  db: Database.Database;
  signingKey: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const fastify = Fastify({ logger: false });

  const mandateStore = createMandateStore(opts.db, opts.signingKey);
  const mandateService = new MandateService(mandateStore);
  fastify.register(mandateRoutes, { service: mandateService });

  const auditStore = createAuditStore(opts.db);
  const auditService = new AuditService(auditStore);
  fastify.register(auditRoutes, { service: auditService });

  fastify.register(uiRoutes);

  return fastify;
}
