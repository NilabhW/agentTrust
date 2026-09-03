import { randomUUID, JsonWebKey } from "node:crypto";
import { signAgentRequest, AgentSignedPayload } from "../gateway/agent-signature";
import { Category } from "../mandate/types";
import { getCatalog } from "./catalog";
import { CatalogItem } from "./types";
import { FunctionDeclaration } from "./gemini-client";

// The buyer agent's tools. submit_purchase is the ONLY path to a purchase --
// it signs the request with the agent's own mandate keypair and POSTs it to
// the real, already-running Gateway over HTTP, exactly like any external
// agent would (per the buildspec: "the Gateway treats it as untrusted
// input, same as anything else"). There is deliberately no direct path to
// src/razorpay/ from this module -- the Gateway is the only door.

export const BROWSE_CATALOG_DECLARATION: FunctionDeclaration = {
  name: "browse_catalog",
  description: "List items available for purchase, optionally filtered by category.",
  parameters: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: ["groceries", "food_delivery", "subscriptions", "electronics"],
        description: "Optional category filter.",
      },
    },
  },
};

export const SUBMIT_PURCHASE_DECLARATION: FunctionDeclaration = {
  name: "submit_purchase",
  description:
    "Submit a signed purchase request to the Verification Gateway. This is the only way to buy something -- " +
    "there is no other path to payment, and the Gateway independently enforces the spending mandate regardless " +
    "of what is submitted here. The Gateway's response decision will be 'pass', 'hard_fail', or 'step_up' -- " +
    "read the reason and adapt; do not resubmit an identical request that was hard_fail'd.",
  parameters: {
    type: "object",
    properties: {
      item_id: { type: "string", description: "The catalog item id, from browse_catalog." },
      item_name: { type: "string", description: "Human-readable name of the item." },
      amount: { type: "number", description: "Price in INR." },
      category: {
        type: "string",
        enum: ["groceries", "food_delivery", "subscriptions", "electronics"],
      },
    },
    required: ["item_id", "item_name", "amount", "category"],
  },
};

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [BROWSE_CATALOG_DECLARATION, SUBMIT_PURCHASE_DECLARATION];

export interface ToolContext {
  mandateId: string;
  privateKeyJwk: JsonWebKey;
  gatewayUrl: string;
  fetchImpl?: typeof fetch;
}

export function browseCatalog(args: { category?: string }): CatalogItem[] {
  return getCatalog(args.category as Category | undefined);
}

export async function submitPurchase(
  args: { item_id?: string; item_name?: string; amount?: number; category?: string },
  ctx: ToolContext
): Promise<unknown> {
  if (typeof args.amount !== "number" || typeof args.category !== "string" || typeof args.item_name !== "string") {
    return { error: "submit_purchase requires item_name, amount, and category" };
  }

  const payload: AgentSignedPayload = {
    mandate_id: ctx.mandateId,
    amount: args.amount,
    category: args.category as Category,
    item_description: args.item_name,
    timestamp: Date.now(),
    nonce: randomUUID(),
  };
  const agent_signature = signAgentRequest(payload, ctx.privateKeyJwk);
  const fetchImpl = ctx.fetchImpl ?? fetch;

  try {
    const response = await fetchImpl(`${ctx.gatewayUrl}/gateway/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, agent_signature }),
    });
    return await response.json();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeToolCall(
  call: { name: string; args: Record<string, unknown> },
  ctx: ToolContext
): Promise<unknown> {
  if (call.name === "browse_catalog") {
    return browseCatalog(call.args as { category?: string });
  }
  if (call.name === "submit_purchase") {
    return submitPurchase(call.args as Parameters<typeof submitPurchase>[0], ctx);
  }
  return { error: `Unknown tool: ${call.name}` };
}
