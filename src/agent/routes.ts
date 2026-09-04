import type { FastifyInstance } from "fastify";
import { MandateStore } from "../mandate/store";
import { MandateNotFoundError, MandateIntegrityError } from "../mandate/errors";
import { loadDemoKeys } from "../demo/keys";
import { runBuyerAgent } from "./loop";
import { GroqAgentClient } from "./groq-agent-client";

// Lets the dashboard's "Run Buyer Agent" panel trigger Program 5 without a
// terminal. This is a UI convenience, not a new trust boundary: it reads a
// demo private key off disk exactly like src/demo/routes.ts already does,
// and the agent's own submit_purchase tool call still goes out over real
// HTTP to /gateway/verify -- self-referentially, to this same server -- so
// the Gateway still can't tell the difference from an externally-run
// scripts/run-buyer-agent.ts. Only who *invoked* runBuyerAgent() changed.

export interface AgentRoutesOptions {
  mandateStore: MandateStore;
  demoKeysPath: string;
  groqApiKey: string;
  groqAgentModel?: string;
  fetchImpl?: typeof fetch;
}

export async function agentRoutes(fastify: FastifyInstance, opts: AgentRoutesOptions) {
  fastify.post("/agent/run", async (request, reply) => {
    const body = request.body as { mandate_id?: string; goal?: string };

    if (!body.goal || !body.goal.trim()) {
      return reply.code(400).send({ error: "goal is required" });
    }

    const demoKeys = loadDemoKeys(opts.demoKeysPath);
    const entry = body.mandate_id ? demoKeys?.[body.mandate_id] : undefined;
    if (!entry) {
      return reply.code(400).send({ error: "Unknown demo mandate_id. Create or seed a demo mandate first." });
    }

    let mandate;
    try {
      mandate = opts.mandateStore.getById(body.mandate_id!, Date.now());
    } catch (err) {
      if (err instanceof MandateNotFoundError || err instanceof MandateIntegrityError) {
        return reply.code(400).send({ error: "Mandate not found or invalid." });
      }
      throw err;
    }

    // Self-referential: reply back through whatever host:port this very
    // request arrived on, since that's guaranteed to reach this same server.
    const gatewayUrl = `${request.protocol}://${request.headers.host}`;
    const contentGenerator = new GroqAgentClient({
      apiKey: opts.groqApiKey,
      model: opts.groqAgentModel,
      fetchImpl: opts.fetchImpl,
    });

    const transcript = await runBuyerAgent({
      goal: body.goal,
      mandateId: body.mandate_id!,
      agentId: mandate.agent_id,
      allowedCategories: mandate.category,
      contentGenerator,
      toolContext: { gatewayUrl, privateKeyJwk: entry.privateKeyJwk },
    });

    return reply.code(200).send({ transcript });
  });
}
