import Fastify, { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createMandateStore } from "./mandate/store";
import { MandateService } from "./mandate/service";
import { mandateRoutes } from "./mandate/routes";

export interface BuildAppOptions {
  db: Database.Database;
  signingKey: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const fastify = Fastify({ logger: false });
  const store = createMandateStore(opts.db, opts.signingKey);
  const service = new MandateService(store);

  fastify.register(mandateRoutes, { service });

  return fastify;
}
